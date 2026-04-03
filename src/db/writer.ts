import type { DbClient } from "./client";
import type { Logger } from "pino";
import type { DecodedInstruction } from "../indexer/decoder";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstructionRecord {
    instruction: DecodedInstruction;
    signature: string;
    slot: number;
    blockTime: Date | null;
    success: boolean;
}

export interface AccountRecord {
    accountName: string;                  // IDL type name, e.g. "Offer"
    pubkey: string;                       // base58
    slot: number;
    lamports: number | null;
    data: Record<string, unknown>;        // decoded fields from BorshAccountsCoder
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "");
}

// Recursively serialises values that pg cannot handle natively:
// BigInt → decimal string, PublicKey → base58, Buffer → hex.
// Nested objects (JSONB columns) are walked recursively.
function safeSerialize(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(safeSerialize);
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                k,
                safeSerialize(v),
            ])
        );
    }
    return value;
}

// ─── writeInstruction ─────────────────────────────────────────────────────────

export async function writeInstruction(
    db: DbClient,
    tableName: string,
    record: InstructionRecord,
    logger: Logger
): Promise<void> {
    const { instruction, signature, slot, blockTime, success } = record;

    const baseColumns = ["signature", "slot", "block_time", "success", "caller"];
    const baseValues: unknown[] = [
        signature, slot, blockTime, success,
        instruction.accounts[0] ?? null,
    ];

    const argColumns = Object.keys(instruction.args).map(k => `arg_${toSnake(k)}`);
    const argValues = Object.values(instruction.args).map(safeSerialize);

    const columns = [...baseColumns, ...argColumns];
    const values = [...baseValues, ...argValues];
    const ph = values.map((_, i) => `$${i + 1}`).join(", ");

    await db.query(
        `INSERT INTO ${tableName} (${columns.join(", ")})
         VALUES (${ph})
         ON CONFLICT (signature) DO NOTHING`,
        values
    );

    logger.debug({ tableName, signature }, "Instruction written");
}

// ─── writeAccount ─────────────────────────────────────────────────────────────
// Upserts one decoded account row.
//
// UPSERT semantics:
//   ON CONFLICT (pubkey) DO UPDATE … WHERE <table>.slot <= EXCLUDED.slot
//
// Meaning: overwrite the existing row only when the incoming data comes from
// the same slot or a *newer* one.  This prevents a stale full-sweep from
// rolling back a more recent per-transaction realtime update.

export async function writeAccount(
    db: DbClient,
    tableName: string,
    record: AccountRecord,
    logger: Logger
): Promise<void> {
    const { pubkey, slot, lamports, data } = record;

    // BorshAccountsCoder returns snake_case keys for IDLs whose field names
    // are already snake_case (confirmed by live test against Anchor v0.32).
    // toSnake() is idempotent so it's safe to apply regardless.
    const dataColumns = Object.keys(data).map(k => toSnake(k));
    const dataValues = Object.values(data).map(safeSerialize);

    const columns = ["pubkey", "slot", "lamports", ...dataColumns];
    const values = [pubkey, slot, lamports, ...dataValues];
    const ph = values.map((_, i) => `$${i + 1}`).join(", ");

    const updateSet = [
        "slot     = EXCLUDED.slot",
        "lamports = EXCLUDED.lamports",
        ...dataColumns.map(c => `${c} = EXCLUDED.${c}`),
    ].join(", ");

    await db.query(
        `INSERT INTO ${tableName} (${columns.join(", ")})
         VALUES (${ph})
         ON CONFLICT (pubkey) DO UPDATE
             SET ${updateSet}
             WHERE ${tableName}.slot <= EXCLUDED.slot`,
        values
    );

    logger.debug({ tableName, pubkey }, "Account written");
}

// ─── writeBatch ───────────────────────────────────────────────────────────────
// Writes a mixed batch of instructions and (optionally) accounts inside a
// single database transaction.  The accounts slice is usually empty here
// because account state is populated by sweepAccounts / sweepSingleAccount,
// which call writeAccount directly.  The parameter is kept so callers that
// do have pre-decoded account records can flush them in the same round-trip.

export async function writeBatch(
    db: DbClient,
    instructions: { tableName: string; record: InstructionRecord }[],
    accounts: { tableName: string; record: AccountRecord }[],
    logger: Logger
): Promise<void> {
    await db.transaction(async (client) => {

        // ── Instructions ─────────────────────────────────────────────────────
        for (const { tableName, record } of instructions) {
            const { instruction, signature, slot, blockTime, success } = record;

            const baseColumns = ["signature", "slot", "block_time", "success", "caller"];
            const baseValues: unknown[] = [
                signature, slot, blockTime, success,
                instruction.accounts[0] ?? null,
            ];

            const argColumns = Object.keys(instruction.args).map(k => `arg_${toSnake(k)}`);
            const argValues = Object.values(instruction.args).map(safeSerialize);

            const columns = [...baseColumns, ...argColumns];
            const values = [...baseValues, ...argValues];
            const ph = values.map((_, i) => `$${i + 1}`).join(", ");

            await client.query(
                `INSERT INTO ${tableName} (${columns.join(", ")})
                 VALUES (${ph})
                 ON CONFLICT (signature) DO NOTHING`,
                values
            );
        }

        // ── Accounts ─────────────────────────────────────────────────────────
        for (const { tableName, record } of accounts) {
            const { pubkey, slot, lamports, data } = record;

            const dataColumns = Object.keys(data).map(k => toSnake(k));
            const dataValues = Object.values(data).map(safeSerialize);

            const columns = ["pubkey", "slot", "lamports", ...dataColumns];
            const values = [pubkey, slot, lamports, ...dataValues];
            const ph = values.map((_, i) => `$${i + 1}`).join(", ");

            const updateSet = [
                "slot     = EXCLUDED.slot",
                "lamports = EXCLUDED.lamports",
                ...dataColumns.map(c => `${c} = EXCLUDED.${c}`),
            ].join(", ");

            await client.query(
                `INSERT INTO ${tableName} (${columns.join(", ")})
                 VALUES (${ph})
                 ON CONFLICT (pubkey) DO UPDATE
                     SET ${updateSet}
                     WHERE ${tableName}.slot <= EXCLUDED.slot`,
                values
            );
        }
    });

    logger.info(
        { instructions: instructions.length, accounts: accounts.length },
        "Batch written"
    );
}