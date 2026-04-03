import { PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { RpcClient } from "../utils/rpc";
import type { Decoder } from "./decoder";
import type { DbClient } from "../db/client";
import type { ParsedIdl } from "../idl/types";
import { writeBatch } from "../db/writer";
import type { InstructionRecord } from "../db/writer";
import { sweepAccounts } from "./account-sweeper";

// ─── Config ───────────────────────────────────────────────────────────────────

const SIGNATURES_PER_PAGE = 1000;
const TX_BATCH_SIZE = 3;
const PROGRESS_EVERY = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

// ─── fetchSignaturesBySlotRange ───────────────────────────────────────────────

async function fetchSignaturesBySlotRange(
    rpc: RpcClient,
    programId: PublicKey,
    startSlot: number,
    endSlot: number,
    logger: Logger
): Promise<string[]> {
    const signatures: string[] = [];
    let before: string | undefined;

    logger.info({ startSlot, endSlot }, "Fetching signatures for slot range...");

    while (true) {
        const page = await rpc.getSignaturesForAddress(programId, { limit: SIGNATURES_PER_PAGE, before });
        if (page.length === 0) break;

        for (const sig of page) {
            if (sig.slot < startSlot) return signatures;   // RPC returns newest→oldest
            if (sig.slot <= endSlot) signatures.push(sig.signature);
        }

        if (page.length < SIGNATURES_PER_PAGE) break;
        before = page[page.length - 1]?.signature;
    }

    return signatures;
}

// ─── processTx ───────────────────────────────────────────────────────────────

async function processTx(
    signature: string,
    rpc: RpcClient,
    decoder: Decoder,
    logger: Logger
): Promise<{ ixRecords: { tableName: string; record: InstructionRecord }[] } | null> {
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

    const ixRecords = instructions.map((ix) => ({
        tableName: `ix_${toSnake(ix.name)}`,
        record: { instruction: ix, signature, slot, blockTime, success } as InstructionRecord,
    }));

    return { ixRecords };
}

// ─── runBatch ─────────────────────────────────────────────────────────────────

export interface BatchOptions {
    programId: PublicKey;
    startSlot?: number;
    endSlot?: number;
    signatures?: string[];
    skipAccountSweep?: boolean;   // set true in unit tests or offline environments
}

export async function runBatch(
    opts: BatchOptions,
    rpc: RpcClient,
    decoder: Decoder,
    idl: ParsedIdl,
    db: DbClient,
    logger: Logger
): Promise<void> {
    const log = logger.child({ module: "batch-indexer" });

    // ─── 1. Collect signatures ────────────────────────────────────────────────

    let signatures: string[];

    if (opts.signatures && opts.signatures.length > 0) {
        signatures = [...new Set(opts.signatures)];
        log.info({ count: signatures.length }, "Using provided signature list");
    } else if (opts.startSlot !== undefined && opts.endSlot !== undefined) {
        signatures = await fetchSignaturesBySlotRange(
            rpc, opts.programId, opts.startSlot, opts.endSlot, log
        );
        log.info({ count: signatures.length }, "Signatures fetched for slot range");
    } else {
        throw new Error("runBatch: provide either signatures or startSlot + endSlot");
    }

    // ─── 2. Process transactions ──────────────────────────────────────────────

    if (signatures.length === 0) {
        log.info("No signatures to process");
    } else {
        let processed = 0;
        let failed = 0;
        const total = signatures.length;

        for (let i = 0; i < total; i += TX_BATCH_SIZE) {
            const batch = signatures.slice(i, i + TX_BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(sig => processTx(sig, rpc, decoder, log))
            );

            const ixRecords: { tableName: string; record: InstructionRecord }[] = [];

            for (let j = 0; j < results.length; j++) {
                const r = results[j];
                if (r?.status === "rejected") {
                    failed++;
                    log.warn({ signature: batch[j], err: r.reason }, "Failed to process tx — skipping");
                } else if (r?.value) {
                    ixRecords.push(...r.value.ixRecords);
                    processed++;
                } else {
                    processed++;   // tx had no matching instructions — still counts
                }
            }

            if (ixRecords.length > 0) {
                await writeBatch(db, ixRecords, [], log);
            }

            if (processed % PROGRESS_EVERY === 0 || i + TX_BATCH_SIZE >= total) {
                const pct = ((processed / total) * 100).toFixed(1);
                log.info({ processed, total, failed, pct: `${pct}%` }, "Batch progress");
            }
        }

        log.info({ processed, failed, total }, "Transaction batch complete");
    }

    // ─── 3. Account sweep ─────────────────────────────────────────────────────
    // Runs AFTER all transactions so acc_ tables reflect the final on-chain state.
    //
    // Why here and not inline in processTx?
    // getParsedTransaction does not return raw account bytes; only
    // getProgramAccounts does.  Running one sweep at the end is also more
    // efficient than one call per transaction.

    if (opts.skipAccountSweep) {
        log.info("Account sweep skipped (skipAccountSweep=true)");
        return;
    }

    if (idl.accounts.length === 0) {
        log.info("IDL has no account types — nothing to sweep");
        return;
    }

    await sweepAccounts(opts.programId, rpc, decoder, idl, db, log);
}