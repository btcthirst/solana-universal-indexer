import { PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { RpcClient } from "../utils/rpc";
import type { Decoder } from "./decoder";
import type { DbClient } from "../db/client";
import type { ParsedIdl } from "../idl/types";
import { writeAccount } from "../db/writer";
import type { AccountRecord } from "../db/writer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function accountTable(name: string): string {
    return `acc_${toSnake(name)}`;
}

// Normalises whatever @solana/web3.js hands back for account.data:
//   • no encoding option  → Buffer   (most common, avoids round-trip)
//   • encoding: "base64"  → [b64string, "base64"]
//   • encoding: "base58"  → string
// Returns null for anything unrecognisable so callers can skip safely.
function toBuffer(data: unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data) && typeof data[0] === "string") {
        return Buffer.from(data[0], "base64");
    }
    if (typeof data === "string") {
        return Buffer.from(data, "base64");
    }
    return null;
}

// ─── sweepAccounts ────────────────────────────────────────────────────────────
// Fetches every on-chain account owned by the program in one RPC call,
// identifies each type by its 8-byte Anchor discriminator, decodes fields
// via BorshAccountsCoder, and upserts into the matching acc_<type> table.
//
// Why a separate sweep and not inline during transaction processing?
// getParsedTransaction returns a human-readable parsed representation where
// raw account bytes are not available. Only getProgramAccounts / getAccountInfo
// expose the raw bytes that BorshAccountsCoder needs.

export async function sweepAccounts(
    programId: PublicKey,
    rpc: RpcClient,
    decoder: Decoder,
    idl: ParsedIdl,
    db: DbClient,
    logger: Logger
): Promise<void> {
    const log = logger.child({ module: "account-sweeper" });

    if (idl.accounts.length === 0) {
        log.info("IDL has no account types — skipping sweep");
        return;
    }

    log.info(
        { programId: programId.toBase58(), types: idl.accounts.map(a => a.name) },
        "Starting account sweep"
    );

    // Call without an encoding option so @solana/web3.js decodes base64 for
    // us and returns Buffer directly — no manual base64 conversion needed.
    let rawAccounts: Awaited<ReturnType<typeof rpc.getProgramAccounts>>;
    try {
        rawAccounts = await rpc.getProgramAccounts(programId);
    } catch (err) {
        log.error({ err }, "getProgramAccounts failed — skipping account sweep");
        return;
    }

    if (rawAccounts.length === 0) {
        log.info("No on-chain accounts found for program");
        return;
    }

    log.info({ count: rawAccounts.length }, "Fetched raw program accounts");

    // Snapshot the current slot once for the whole sweep so every row
    // gets the same slot value and UPSERT ordering is consistent.
    let currentSlot = 0;
    try {
        currentSlot = await rpc.getSlot();
    } catch {
        log.warn("Could not fetch current slot — using 0");
    }

    let written = 0;
    let skipped = 0;
    let failed = 0;

    for (const { pubkey, account } of rawAccounts) {
        // ── 1. Normalise data to Buffer ───────────────────────────────────────
        const dataBuffer = toBuffer(account.data);
        if (!dataBuffer || dataBuffer.length < 8) {
            // Fewer than 8 bytes → can't hold a discriminator; skip silently.
            skipped++;
            continue;
        }

        // ── 2. Identify account type by Anchor discriminator (first 8 bytes) ─
        const accountType = decoder.identifyAccountType(dataBuffer);
        if (!accountType) {
            // Token accounts, system accounts, etc. → expected, not an error.
            skipped++;
            continue;
        }

        // ── 3. Decode fields via BorshAccountsCoder ───────────────────────────
        const fields = decoder.decodeAccount(accountType, dataBuffer);
        if (!fields) {
            log.warn(
                { pubkey: pubkey.toBase58(), accountType },
                "decodeAccount returned null — skipping"
            );
            failed++;
            continue;
        }

        // ── 4. UPSERT into acc_<type> ─────────────────────────────────────────
        const record: AccountRecord = {
            accountName: accountType,
            pubkey: pubkey.toBase58(),
            slot: currentSlot,
            lamports: account.lamports,
            data: fields,
        };

        try {
            await writeAccount(db, accountTable(accountType), record, log);
            written++;
        } catch (err) {
            log.warn(
                { err, pubkey: pubkey.toBase58(), table: accountTable(accountType) },
                "writeAccount failed — skipping"
            );
            failed++;
        }
    }

    log.info(
        { total: rawAccounts.length, written, skipped, failed },
        "Account sweep complete"
    );
}

// ─── sweepSingleAccount ───────────────────────────────────────────────────────
// Lightweight per-account refresh used in realtime mode after each transaction.
// Uses getAccountInfo (one RPC call per pubkey) instead of getProgramAccounts
// so we don't re-fetch the entire program's account set on every transaction.

export async function sweepSingleAccount(
    pubkeyStr: string,
    rpc: RpcClient,
    decoder: Decoder,
    idl: ParsedIdl,
    db: DbClient,
    slot: number,
    logger: Logger
): Promise<boolean> {
    if (idl.accounts.length === 0) return false;

    let pubkey: PublicKey;
    try {
        pubkey = new PublicKey(pubkeyStr);
    } catch {
        // Not a valid base58 pubkey — skip silently (e.g. system program addresses).
        return false;
    }

    let accountInfo: Awaited<ReturnType<typeof rpc.connection.getAccountInfo>>;
    try {
        accountInfo = await rpc.connection.getAccountInfo(pubkey, "confirmed");
    } catch (err) {
        logger.warn({ err, pubkey: pubkeyStr }, "getAccountInfo failed");
        return false;
    }

    // null = account closed or not owned by our program
    if (!accountInfo) return false;

    const dataBuffer = toBuffer(accountInfo.data);
    if (!dataBuffer || dataBuffer.length < 8) return false;

    const accountType = decoder.identifyAccountType(dataBuffer);
    if (!accountType) return false;

    const fields = decoder.decodeAccount(accountType, dataBuffer);
    if (!fields) return false;

    const record: AccountRecord = {
        accountName: accountType,
        pubkey: pubkeyStr,
        slot,
        lamports: accountInfo.lamports,
        data: fields,
    };

    try {
        await writeAccount(db, accountTable(accountType), record, logger);
        return true;
    } catch (err) {
        logger.warn({ err, pubkey: pubkeyStr }, "sweepSingleAccount: writeAccount failed");
        return false;
    }
}