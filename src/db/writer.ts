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
    accountName: string;        // IDL account type name, e.g. "Offer"
    pubkey: string;
    slot: number;
    lamports: number | null;
    data: Record<string, unknown>;   // decoded fields from BorshAccountsCoder
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "");
}

// Recursive serialization — BigInt → string, others passthrough for JSONB fields
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
    const baseValues: unknown[] = [signature, slot, blockTime, success, instruction.accounts[0] ?? null];

    const argColumns = Object.keys(instruction.args).map(
        (k) => `arg_${toSnake(k)}`
    );
    const argValues = Object.values(instruction.args).map(safeSerialize);

    const columns = [...baseColumns, ...argColumns];
    const values = [...baseValues, ...argValues];

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const sql = `
        INSERT INTO ${tableName} (${columns.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT (signature) DO NOTHING
    `;

    await db.query(sql, values);
    logger.debug({ tableName, signature }, "Instruction written");
}

// ─── writeAccount ─────────────────────────────────────────────────────────────
// Upserts one decoded account into its acc_<type> table.
// The UPSERT condition "WHERE table.slot <= EXCLUDED.slot" means:
//   overwrite only when the incoming data is from an equal-or-newer slot,
//   i.e. keep the latest known state and never regress to older data.

export async function writeAccount(
    db: DbClient,
    tableName: string,
    record: AccountRecord,
    logger: Logger
): Promise<void> {
    const { pubkey, slot, lamports, data } = record;

    const baseColumns = ["pubkey", "slot", "lamports"];
    const baseValues: unknown[] = [pubkey, slot, lamports];

    // data keys come from BorshAccountsCoder — already snake_case for IDLs
    // that use snake_case field names. toSnake() is safe to call twice.
    const dataColumns = Object.keys(data).map((k) => toSnake(k));
    const dataValues = Object.values(data).map(safeSerialize);

    const columns = [...baseColumns, ...dataColumns];
    const values = [...baseValues, ...dataValues];

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    // Build the SET list for every column except pubkey (the PK).
    const updateSet = [
        "slot = EXCLUDED.slot",
        "lamports = EXCLUDED.lamports",
        ...dataColumns.map((c) => `${c} = EXCLUDED.${c}`),
    ].join(", ");

    // Only overwrite when the new data is from the same or a later slot.
    // This prevents a stale sweep from reverting a more recent realtime update.
    const sql = `
        INSERT INTO ${tableName} (${columns.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT (pubkey) DO UPDATE
            SET ${updateSet}
            WHERE ${tableName}.slot <= EXCLUDED.slot
    `;

    await db.query(sql, values);
    logger.debug({ tableName, pubkey }, "Account written");
}

// ─── writeBatch ───────────────────────────────────────────────────────────────
// Writes a mixed batch of instruction and account records inside one transaction.

export async function writeBatch(
    db: DbClient,
    instructions: { tableName: string; record: InstructionRecord }[],
    accounts: { tableName: string; record: AccountRecord }[],
    logger: Logger
): Promise<void> {
    await db.transaction(async (client) => {
        // ── Instructions ──────────────────────────────────────────────────────
        for (const { tableName, record } of instructions) {
            const { instruction, signature, slot, blockTime, success } = record;

            const baseColumns = ["signature", "slot", "block_time", "success", "caller"];
            const baseValues: unknown[] = [
                signature, slot, blockTime, success,
                instruction.accounts[0] ?? null,
            ];

            const argColumns = Object.keys(instruction.args).map(
                (k) => `arg_${toSnake(k)}`
            );
            const argValues = Object.values(instruction.args).map(safeSerialize);

            const columns = [...baseColumns, ...argColumns];
            const values = [...baseValues, ...argValues];
            const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

            await client.query(
                `INSERT INTO ${tableName} (${columns.join(", ")})
                 VALUES (${placeholders})
                 ON CONFLICT (signature) DO NOTHING`,
                values
            );
        }

        // ── Accounts ──────────────────────────────────────────────────────────
        for (const { tableName, record } of accounts) {
            const { pubkey, slot, lamports, data } = record;

            const baseColumns = ["pubkey", "slot", "lamports"];
            const baseValues: unknown[] = [pubkey, slot, lamports];

            const dataColumns = Object.keys(data).map((k) => toSnake(k));
            const dataValues = Object.values(data).map(safeSerialize);

            const columns = [...baseColumns, ...dataColumns];
            const values = [...baseValues, ...dataValues];
            const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

            const updateSet = [
                "slot = EXCLUDED.slot",
                "lamports = EXCLUDED.lamports",
                ...dataColumns.map((c) => `${c} = EXCLUDED.${c}`),
            ].join(", ");

            await client.query(
                `INSERT INTO ${tableName} (${columns.join(", ")})
                 VALUES (${placeholders})
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