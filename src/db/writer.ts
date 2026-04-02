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
    accountName: string;
    pubkey: string;
    slot: number;
    lamports: number | null;
    data: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "");
}

// Recursive serialization — BigInt → string, others via JSON for JSONB fields
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

    // System columns
    const baseColumns = ["signature", "slot", "block_time", "success", "caller"];
    const baseValues: unknown[] = [signature, slot, blockTime, success, instruction.accounts[0] ?? null];

    // Instruction arguments → arg_ prefix, snake_case
    const argColumns = Object.keys(instruction.args).map(
        (k) => `arg_${toSnake(k)}`
    );
    const argValues = Object.values(instruction.args).map(safeSerialize);

    const columns = [...baseColumns, ...argColumns];
    const values = [...baseValues, ...argValues];

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const columnList = columns.join(", ");

    const sql = `
    INSERT INTO ${tableName} (${columnList})
    VALUES (${placeholders})
    ON CONFLICT (signature) DO NOTHING
  `;

    await db.query(sql, values);
    logger.debug({ tableName, signature }, "Instruction written");
}

// ─── writeAccount ─────────────────────────────────────────────────────────────

export async function writeAccount(
    db: DbClient,
    tableName: string,
    record: AccountRecord,
    logger: Logger
): Promise<void> {
    const { pubkey, slot, lamports, data } = record;

    const baseColumns = ["pubkey", "slot", "lamports"];
    const baseValues: unknown[] = [pubkey, slot, lamports];

    const dataColumns = Object.keys(data).map((k) => toSnake(k));
    const dataValues = Object.values(data).map(safeSerialize);

    const columns = [...baseColumns, ...dataColumns];
    const values = [...baseValues, ...dataValues];

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const columnList = columns.join(", ");

    // UPSERT — update if the slot is newer
    const updateSet = ["slot = EXCLUDED.slot", "lamports = EXCLUDED.lamports",
        ...dataColumns.map((c) => `${c} = EXCLUDED.${c}`),
    ].join(", ");

    const sql = `
    INSERT INTO ${tableName} (${columnList})
    VALUES (${placeholders})
    ON CONFLICT (pubkey) DO UPDATE SET ${updateSet}
    WHERE ${tableName}.slot <= EXCLUDED.slot
  `;

    await db.query(sql, values);
    logger.debug({ tableName, pubkey }, "Account written");
}

// ─── writeBatch ───────────────────────────────────────────────────────────────

export async function writeBatch(
    db: DbClient,
    instructions: { tableName: string; record: InstructionRecord }[],
    accounts: { tableName: string; record: AccountRecord }[],
    logger: Logger
): Promise<void> {
    await db.transaction(async (client) => {
        for (const { tableName, record } of instructions) {
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

            await client.query(
                `INSERT INTO ${tableName} (${columns.join(", ")})
         VALUES (${placeholders})
         ON CONFLICT (signature) DO NOTHING`,
                values
            );
        }

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
         ON CONFLICT (pubkey) DO UPDATE SET ${updateSet}
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