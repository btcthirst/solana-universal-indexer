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

// ─── Fetch signatures by slot range ──────────────────────────────────────────

async function fetchSignaturesBySlotRange(
    rpc: RpcClient,
    programId: PublicKey,
    startSlot: number,
    endSlot: number,
    logger: Logger
): Promise<string[]> {
    const signatures: string[] = [];
    let before: string | undefined = undefined;

    logger.info({ startSlot, endSlot }, "Fetching signatures for slot range...");

    while (true) {
        const page = await rpc.getSignaturesForAddress(programId, {
            limit: SIGNATURES_PER_PAGE,
            before,
        });

        if (page.length === 0) break;

        for (const sig of page) {
            if (sig.slot < startSlot) {
                logger.debug({ slot: sig.slot, startSlot }, "Reached startSlot boundary — stopping");
                return signatures;
            }
            if (sig.slot <= endSlot) {
                signatures.push(sig.signature);
            }
        }

        if (page.length < SIGNATURES_PER_PAGE) break;
        before = page[page.length - 1]?.signature;
    }

    return signatures;
}

// ─── Process one transaction ──────────────────────────────────────────────────

async function processTx(
    signature: string,
    rpc: RpcClient,
    decoder: Decoder,
    idl: ParsedIdl,
    db: DbClient,
    logger: Logger
): Promise<void> {
    const tx = await rpc.getTransaction(signature);
    if (!tx) {
        logger.warn({ signature }, "Transaction not found — skipping");
        return;
    }

    const instructions = decoder.extractInstructions(tx);
    if (instructions.length === 0) return;

    const slot = tx.slot;
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const success = tx.meta?.err === null;

    const ixRecords: { tableName: string; record: InstructionRecord }[] = instructions.map((ix) => ({
        tableName: `ix_${toSnake(ix.name)}`,
        record: { instruction: ix, signature, slot, blockTime, success },
    }));

    // Accounts are NOT decoded inline here because getParsedTransaction does
    // not return raw account bytes. sweepAccounts() handles acc_ tables after
    // all transactions finish — see the end of runBatch().
    await writeBatch(db, ixRecords, [], logger);
}

// ─── runBatch ─────────────────────────────────────────────────────────────────

export interface BatchOptions {
    programId: PublicKey;
    startSlot?: number;
    endSlot?: number;
    signatures?: string[];
    skipAccountSweep?: boolean;   // useful in tests or CI environments without RPC
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

    // ─── Collect signatures ───────────────────────────────────────────────────

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

    // ─── Process transactions ─────────────────────────────────────────────────

    if (signatures.length === 0) {
        log.info("No signatures to process");
    } else {
        let processed = 0;
        let failed = 0;
        const total = signatures.length;

        for (let i = 0; i < total; i += TX_BATCH_SIZE) {
            const batch = signatures.slice(i, i + TX_BATCH_SIZE);

            const results = await Promise.allSettled(
                batch.map((sig) => processTx(sig, rpc, decoder, idl, db, log))
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                if (result?.status === "rejected") {
                    failed++;
                    log.warn(
                        { signature: batch[j], err: result.reason },
                        "Failed to process transaction — skipping"
                    );
                } else {
                    processed++;
                }
            }

            if (processed % PROGRESS_EVERY === 0 || i + TX_BATCH_SIZE >= total) {
                const pct = ((processed / total) * 100).toFixed(1);
                log.info({ processed, total, failed, pct: `${pct}%` }, "Batch progress");
            }
        }

        log.info({ processed, failed, total }, "Transaction batch complete");
    }

    // ─── Account sweep ────────────────────────────────────────────────────────
    // Runs after all transactions so acc_ tables reflect the final on-chain state.
    // getParsedTransaction cannot provide raw account bytes; getProgramAccounts can.

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