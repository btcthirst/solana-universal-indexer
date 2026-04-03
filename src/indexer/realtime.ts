import { PublicKey, Connection } from "@solana/web3.js";
import type { Logger } from "pino";
import type { RpcClient } from "../utils/rpc";
import type { Decoder } from "./decoder";
import type { DbClient } from "../db/client";
import type { ParsedIdl } from "../idl/types";
import { writeBatch } from "../db/writer";
import type { InstructionRecord } from "../db/writer";
import { sweepAccounts, sweepSingleAccount } from "./account-sweeper";

// ─── Config ───────────────────────────────────────────────────────────────────

const SIGNATURES_PER_PAGE = 1000;
const TX_BATCH_SIZE = 10;
const STATE_SAVE_EVERY = 10;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ─── State persistence ────────────────────────────────────────────────────────

async function loadLastSignature(db: DbClient, programId: string, network: string): Promise<string | null> {
    const { rows } = await db.query<{ last_signature: string | null }>(
        `SELECT last_signature FROM _indexer_state
         WHERE key = 'realtime' AND program_id = $1 AND network = $2`,
        [programId, network]
    );
    return rows[0]?.last_signature ?? null;
}

async function saveLastSignature(
    db: DbClient, programId: string, network: string, signature: string, slot: number
): Promise<void> {
    await db.query(
        `INSERT INTO _indexer_state (key, program_id, network, last_signature, last_slot, updated_at)
         VALUES ('realtime', $1, $2, $3, $4, NOW())
         ON CONFLICT (key, program_id, network) DO UPDATE SET
             last_signature = EXCLUDED.last_signature,
             last_slot      = EXCLUDED.last_slot,
             updated_at     = NOW()`,
        [programId, network, signature, slot]
    );
}

// ─── fetchMissedSignatures ────────────────────────────────────────────────────

async function fetchMissedSignatures(
    rpc: RpcClient,
    programId: PublicKey,
    until: string,
    logger: Logger
): Promise<string[]> {
    const signatures: string[] = [];
    let before: string | undefined;

    logger.info({ until }, "Backfill: fetching missed signatures...");

    while (true) {
        const page = await rpc.getSignaturesForAddress(programId, {
            limit: SIGNATURES_PER_PAGE, before, until,
        });
        if (page.length === 0) break;
        for (const s of page) signatures.push(s.signature);
        if (page.length < SIGNATURES_PER_PAGE) break;
        before = page[page.length - 1]?.signature;
    }

    return signatures.reverse();   // chronological order
}

// ─── processTx ───────────────────────────────────────────────────────────────

interface TxResult {
    slot: number;
    ixRecords: { tableName: string; record: InstructionRecord }[];
    // Non-signer writable pubkeys from decoded instructions.
    // These are the PDAs most likely to have changed state.
    writablePubkeys: string[];
}

async function processTx(
    signature: string,
    rpc: RpcClient,
    decoder: Decoder,
    logger: Logger
): Promise<TxResult | null> {
    const tx = await rpc.getTransaction(signature);
    if (!tx) {
        logger.warn({ signature }, "Transaction not found — skipping");
        return null;
    }

    const instructions = decoder.extractInstructions(tx);
    if (instructions.length === 0) return null;

    const slot = tx.slot;
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const success = tx.meta?.err === null;

    const ixRecords = instructions.map(ix => ({
        tableName: `ix_${toSnake(ix.name)}`,
        record: { instruction: ix, signature, slot, blockTime, success } as InstructionRecord,
    }));

    // Collect candidate pubkeys for per-account refresh.
    // Skip accounts[0] (typically the fee-payer/signer); everything from
    // index 1 onward may be a program-owned PDA that changed state.
    const writablePubkeys: string[] = [];
    if (success) {
        const seen = new Set<string>();
        for (const ix of instructions) {
            for (let i = 1; i < ix.accounts.length; i++) {
                const pk = ix.accounts[i];
                if (pk && !seen.has(pk)) { seen.add(pk); writablePubkeys.push(pk); }
            }
        }
    }

    return { slot, ixRecords, writablePubkeys };
}

// ─── runBackfill ──────────────────────────────────────────────────────────────

async function runBackfill(
    programId: PublicKey,
    lastSignature: string,
    rpc: RpcClient,
    decoder: Decoder,
    db: DbClient,
    network: string,
    logger: Logger
): Promise<string | null> {
    const signatures = await fetchMissedSignatures(rpc, programId, lastSignature, logger);

    if (signatures.length === 0) {
        logger.info("Backfill: no missed transactions");
        return null;
    }

    logger.info({ count: signatures.length }, "Backfill: processing missed transactions...");

    let processed = 0;
    let latestSignature: string | null = null;
    let latestSlot = 0;

    for (let i = 0; i < signatures.length; i += TX_BATCH_SIZE) {
        const batch = signatures.slice(i, i + TX_BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(sig => processTx(sig, rpc, decoder, logger))
        );

        const ixRecords: { tableName: string; record: InstructionRecord }[] = [];

        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r?.status === "rejected") {
                logger.warn({ signature: batch[j], err: r.reason }, "Backfill tx failed");
                continue;
            }
            if (!r?.value) continue;

            ixRecords.push(...r.value.ixRecords);
            if (r.value.slot > latestSlot) {
                latestSlot = r.value.slot;
                latestSignature = batch[j] ?? null;
            }
            processed++;
        }

        if (ixRecords.length > 0) {
            await writeBatch(db, ixRecords, [], logger);
        }

        if (latestSignature && processed % STATE_SAVE_EVERY === 0) {
            await saveLastSignature(db, programId.toBase58(), network, latestSignature, latestSlot);
        }
    }

    logger.info({ processed }, "Backfill complete");
    return latestSignature;
}

// ─── subscribeWithReconnect ───────────────────────────────────────────────────

function subscribeWithReconnect(
    connection: Connection,
    programId: PublicKey,
    onSignature: (sig: string) => void,
    logger: Logger
): () => void {
    let subId: number | null = null;
    let stopped = false;
    let attempt = 0;

    async function subscribe(): Promise<void> {
        if (stopped) return;
        try {
            subId = connection.onLogs(
                programId,
                logs => { if (!logs.err) onSignature(logs.signature); },
                "confirmed"
            );
            attempt = 0;
            logger.info({ programId: programId.toBase58() }, "WebSocket subscribed");
        } catch (err) {
            attempt++;
            const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** (attempt - 1), WS_RECONNECT_MAX_MS);
            logger.warn({ err, attempt, delayMs: delay }, "WebSocket connection failed — reconnecting");
            await sleep(delay);
            subscribe();
        }
    }

    const watchdog = setInterval(async () => {
        if (stopped || subId === null) return;
        try { await connection.getSlot(); } catch {
            logger.warn("WebSocket watchdog: RPC unreachable — resubscribing");
            if (subId !== null) { connection.removeOnLogsListener(subId).catch(() => { }); subId = null; }
            attempt++;
            const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** (attempt - 1), WS_RECONNECT_MAX_MS);
            await sleep(delay);
            subscribe();
        }
    }, 30_000);

    subscribe();

    return () => {
        stopped = true;
        clearInterval(watchdog);
        if (subId !== null) connection.removeOnLogsListener(subId).catch(() => { });
    };
}

// ─── runRealtime ──────────────────────────────────────────────────────────────

export interface RealtimeOptions {
    programId: PublicKey;
    network: string;
    connection: Connection;
}

export async function runRealtime(
    opts: RealtimeOptions,
    rpc: RpcClient,
    decoder: Decoder,
    idl: ParsedIdl,
    db: DbClient,
    logger: Logger
): Promise<void> {
    const log = logger.child({ module: "realtime-indexer" });
    const { programId, network, connection } = opts;
    const programIdStr = programId.toBase58();
    const hasAccountTypes = idl.accounts.length > 0;

    // ─── Cold start: backfill missed transactions ─────────────────────────────

    const lastSignature = await loadLastSignature(db, programIdStr, network);

    if (lastSignature) {
        log.info({ lastSignature }, "Cold start: backfilling missed transactions...");
        const newLatest = await runBackfill(programId, lastSignature, rpc, decoder, db, network, log);
        if (newLatest) await saveLastSignature(db, programIdStr, network, newLatest, 0);
    } else {
        log.info("Cold start: no previous state — starting fresh");
    }

    // ─── Initial account sweep ────────────────────────────────────────────────
    // Populates all acc_ tables once from the current on-chain state.
    // After this, individual accounts are refreshed per-transaction via
    // sweepSingleAccount() as they change — avoiding a full re-sweep each time.

    if (hasAccountTypes) {
        log.info("Running initial account sweep...");
        await sweepAccounts(programId, rpc, decoder, idl, db, log);
    }

    // ─── Realtime loop ────────────────────────────────────────────────────────

    log.info("Switching to realtime mode...");

    let processedSinceLastSave = 0;
    let latestSignature = lastSignature;
    let latestSlot = 0;

    const stop = subscribeWithReconnect(
        connection,
        programId,
        async (signature) => {
            try {
                const result = await processTx(signature, rpc, decoder, log);
                if (!result) return;

                // 1. Persist instructions
                await writeBatch(db, result.ixRecords, [], log);

                // 2. Refresh each account that the transaction may have mutated.
                //    sweepSingleAccount → getAccountInfo (one call per pubkey),
                //    far cheaper than a full getProgramAccounts on every tx.
                if (hasAccountTypes && result.writablePubkeys.length > 0) {
                    await Promise.allSettled(
                        result.writablePubkeys.map(pk =>
                            sweepSingleAccount(pk, rpc, decoder, idl, db, result.slot, log)
                        )
                    );
                }

                processedSinceLastSave++;
                if (result.slot > latestSlot) {
                    latestSlot = result.slot;
                    latestSignature = signature;
                }

                if (processedSinceLastSave >= STATE_SAVE_EVERY && latestSignature) {
                    await saveLastSignature(db, programIdStr, network, latestSignature, latestSlot);
                    log.debug({ latestSignature, latestSlot }, "Cursor saved");
                    processedSinceLastSave = 0;
                }
            } catch (err) {
                log.warn({ err, signature }, "Failed to process realtime tx — skipping");
            }
        },
        log
    );

    process.on("SIGINT", () => { stop(); process.exit(0); });
    process.on("SIGTERM", () => { stop(); process.exit(0); });

    await new Promise<void>(() => { });
}