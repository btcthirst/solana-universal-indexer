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

// ─── toBuffer ────────────────────────────────────────────────────────────────
// getProgramAccounts without an encoding option returns data as Buffer.
// With encoding:"base64" it returns [string,"base64"].
// We omit encoding so we always get a Buffer and skip the base64 round-trip.

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
// Fetches every on-chain account owned by the program via getProgramAccounts,
// identifies its type by discriminator, decodes with BorshAccountsCoder, and
// upserts into the matching acc_<n> table.
//
// This is the only way to populate acc_ tables because getParsedTransaction
// does not expose raw account bytes — only account-level RPC calls do.

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

    // No encoding option → @solana/web3.js returns data as Buffer directly.
    // This avoids a base64 encode→decode round-trip and simplifies type handling.
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
        const dataBuffer = toBuffer(account.data);

        if (!dataBuffer || dataBuffer.length < 8) {
            skipped++;
            continue;
        }

        // Identify type by the first 8 bytes (Anchor discriminator)
        const accountType = decoder.identifyAccountType(dataBuffer);
        if (!accountType) {
            // Token accounts, system accounts, etc. — expected, not an error
            skipped++;
            continue;
        }

        // Decode all fields via BorshAccountsCoder
        const fields = decoder.decodeAccount(accountType, dataBuffer);
        if (!fields) {
            log.warn(
                { pubkey: pubkey.toBase58(), accountType },
                "Failed to decode account — skipping"
            );
            failed++;
            continue;
        }

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
// Refreshes one account after a realtime transaction that touched it.
// Uses getAccountInfo (cheaper than getProgramAccounts) for a single pubkey.

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
        return false;
    }

    let accountInfo: Awaited<ReturnType<typeof rpc.connection.getAccountInfo>>;
    try {
        accountInfo = await rpc.connection.getAccountInfo(pubkey, "confirmed");
    } catch (err) {
        logger.warn({ err, pubkey: pubkeyStr }, "getAccountInfo failed");
        return false;
    }

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
        logger.warn({ err, pubkey: pubkeyStr }, "sweepSingleAccount writeAccount failed");
        return false;
    }
}