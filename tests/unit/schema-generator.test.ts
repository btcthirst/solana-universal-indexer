import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { generateSchema, applySchema } from "../../src/db/schema-generator";
import type { DbClient } from "../../src/db/client";
import type { ParsedIdl } from "../../src/idl/types";

// ─── Minimal IDL stub ─────────────────────────────────────────────────────────

function makeIdl(overrides: Partial<ParsedIdl> = {}): ParsedIdl {
    return {
        address: "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy",
        name: "test_program",
        version: "0.1.0",
        instructions: [],
        accounts: [],
        types: [],
        events: [],
        errors: [],
        constants: [],
        metadata: { origin: "file", loadedAt: new Date().toISOString() },
        ...overrides,
    };
}

// ─── Mock logger ──────────────────────────────────────────────────────────────

function makeLogger() {
    const l = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        debug: vi.fn(), child: vi.fn(),
    };
    l.child.mockReturnValue(l);
    return l as unknown as Logger;
}

// ─── Mock DB client ───────────────────────────────────────────────────────────

function makeDb(existingTables: string[] = []): DbClient {
    return {
        query: vi.fn().mockResolvedValue({
            rows: existingTables.map((tablename) => ({ tablename })),
        }),
        transaction: vi.fn().mockImplementation(
            async (fn: (c: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
                fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })
        ),
        pool: { end: vi.fn() } as never,
        checkDbConnection: vi.fn(),
    } as unknown as DbClient;
}

// ─── Table name generation ────────────────────────────────────────────────────

describe("generateSchema — table names", () => {
    it("generates ix_ table for each instruction", () => {
        const idl = makeIdl({
            instructions: [
                { name: "makeOffer", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
                { name: "take_offer", discriminator: [0, 0, 0, 0, 0, 0, 0, 1], args: [], accounts: [] },
            ],
        });
        const { tables } = generateSchema(idl);
        expect(tables).toContain("ix_make_offer");
        expect(tables).toContain("ix_take_offer");
    });

    it("generates acc_ table for each account", () => {
        const idl = makeIdl({
            accounts: [{ name: "Offer", discriminator: [0, 0, 0, 0, 0, 0, 0, 0] }],
            types: [{ name: "Offer", type: { kind: "struct", fields: [] } }],
        });
        const { tables } = generateSchema(idl);
        expect(tables).toContain("acc_offer");
    });

    it("always includes _indexer_state", () => {
        const { tables } = generateSchema(makeIdl());
        expect(tables).toContain("_indexer_state");
    });

    it("converts camelCase instruction name to snake_case", () => {
        const idl = makeIdl({
            instructions: [
                { name: "initializeVault", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const { tables } = generateSchema(idl);
        expect(tables).toContain("ix_initialize_vault");
    });
});

// ─── SQL type mapping ─────────────────────────────────────────────────────────

describe("generateSchema — SQL type mapping", () => {
    function sqlFor(type: ParsedIdl["instructions"][number]["args"][number]["type"]): string {
        const idl = makeIdl({
            instructions: [{
                name: "testIx",
                discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
                args: [{ name: "val", type }],
                accounts: [],
            }],
        });
        const { sql } = generateSchema(idl);
        const match = sql.match(/arg_val\s+([^\n,]+)/);
        return match?.[1]?.trim() ?? "";
    }

    it.each([
        ["u8", "INTEGER"],
        ["u16", "INTEGER"],
        ["u32", "INTEGER"],
        ["i8", "INTEGER"],
        ["i16", "INTEGER"],
        ["i32", "INTEGER"],
    ] as const)("%s → INTEGER", (type, expected) => {
        expect(sqlFor(type)).toBe(expected);
    });

    it.each([
        ["u64", "NUMERIC(40)"],
        ["u128", "NUMERIC(40)"],
        ["i64", "NUMERIC(40)"],
        ["i128", "NUMERIC(40)"],
    ] as const)("%s → NUMERIC(40)", (type, expected) => {
        expect(sqlFor(type)).toBe(expected);
    });

    it.each([
        ["f32", "DOUBLE PRECISION"],
        ["f64", "DOUBLE PRECISION"],
    ] as const)("%s → DOUBLE PRECISION", (type, expected) => {
        expect(sqlFor(type)).toBe(expected);
    });

    it("bool → BOOLEAN", () => expect(sqlFor("bool")).toBe("BOOLEAN"));
    it("pubkey → TEXT", () => expect(sqlFor("pubkey")).toBe("TEXT"));
    it("string → TEXT", () => expect(sqlFor("string")).toBe("TEXT"));
    it("bytes → BYTEA", () => expect(sqlFor("bytes")).toBe("BYTEA"));

    it("vec<T> → JSONB", () => {
        expect(sqlFor({ vec: "u64" })).toBe("JSONB");
    });

    it("array<T, N> → JSONB", () => {
        expect(sqlFor({ array: ["u8", 32] })).toBe("JSONB");
    });

    it("defined struct → JSONB", () => {
        expect(sqlFor({ defined: { name: "MyStruct" } })).toBe("JSONB");
    });

    it("coption<T> → JSONB", () => {
        expect(sqlFor({ coption: "u64" })).toBe("JSONB");
    });

    it("unknown string type falls back to TEXT", () => {
        // Cast through unknown to test the default branch
        expect(sqlFor("publicKey" as never)).toBe("TEXT");
    });

    it("option<T> → nullable (no NOT NULL)", () => {
        const sql = sqlFor({ option: "u64" });
        expect(sql).toContain("NUMERIC(40)");
        expect(sql).not.toContain("NOT NULL");
    });

    it("option<bool> → nullable BOOLEAN", () => {
        const sql = sqlFor({ option: "bool" });
        expect(sql).toBe("BOOLEAN");
        expect(sql).not.toContain("NOT NULL");
    });

    it("instruction args are always nullable (tx could fail mid-decode)", () => {
        // buildInstructionTable passes nullable=true for all args so that
        // failed transactions can still be recorded with NULL arg values.
        const sql = sqlFor("u64");
        expect(sql).toBe("NUMERIC(40)");
        expect(sql).not.toContain("NOT NULL");
    });
});

// ─── DDL content ─────────────────────────────────────────────────────────────

describe("generateSchema — DDL content", () => {
    it("ix_ table contains required system columns", () => {
        const idl = makeIdl({
            instructions: [
                { name: "deposit", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const { sql } = generateSchema(idl);
        expect(sql).toContain("signature");
        expect(sql).toContain("slot");
        expect(sql).toContain("block_time");
        expect(sql).toContain("success");
        expect(sql).toContain("caller");
    });

    it("acc_ table contains pubkey primary key", () => {
        const idl = makeIdl({
            accounts: [{ name: "UserAccount", discriminator: [0, 0, 0, 0, 0, 0, 0, 0] }],
            types: [{ name: "UserAccount", type: { kind: "struct", fields: [] } }],
        });
        const { sql } = generateSchema(idl);
        expect(sql).toContain("pubkey");
        expect(sql).toContain("PRIMARY KEY");
    });

    it("DDL uses CREATE TABLE IF NOT EXISTS (idempotent)", () => {
        const { sql } = generateSchema(makeIdl());
        expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    });

    it("creates slot index for ix_ table", () => {
        const idl = makeIdl({
            instructions: [
                { name: "swap", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const { sql } = generateSchema(idl);
        expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_ix_swap_slot");
    });

    it("creates success index for ix_ table", () => {
        const idl = makeIdl({
            instructions: [
                { name: "swap", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const { sql } = generateSchema(idl);
        expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_ix_swap_success");
    });

    it("creates slot index for acc_ table", () => {
        const idl = makeIdl({
            accounts: [{ name: "Vault", discriminator: [0, 0, 0, 0, 0, 0, 0, 0] }],
            types: [{ name: "Vault", type: { kind: "struct", fields: [] } }],
        });
        const { sql } = generateSchema(idl);
        expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_acc_vault_slot");
    });

    it("acc_ table uses empty fields when no matching type def", () => {
        // Account name doesn't match any type in idl.types → fields = []
        const idl = makeIdl({
            accounts: [{ name: "Orphan", discriminator: [0, 0, 0, 0, 0, 0, 0, 0] }],
            types: [], // no matching typedef
        });
        const { sql } = generateSchema(idl);
        // Should still generate the table without crashing
        expect(sql).toContain("CREATE TABLE IF NOT EXISTS acc_orphan");
    });

    it("returns correct table list length", () => {
        const idl = makeIdl({
            instructions: [
                { name: "ix1", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
                { name: "ix2", discriminator: [0, 0, 0, 0, 0, 0, 0, 1], args: [], accounts: [] },
            ],
            accounts: [{ name: "Acc1", discriminator: [0, 0, 0, 0, 0, 0, 0, 2] }],
            types: [{ name: "Acc1", type: { kind: "struct", fields: [] } }],
        });
        const { tables } = generateSchema(idl);
        // _indexer_state + ix_ix1 + ix_ix2 + acc_acc1 = 4
        expect(tables).toHaveLength(4);
    });
});

// ─── applySchema ──────────────────────────────────────────────────────────────

describe("applySchema", () => {
    it("runs the generated SQL inside a transaction", async () => {
        const idl = makeIdl({
            instructions: [
                { name: "transfer", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const db = makeDb(["_indexer_state", "ix_transfer"]);
        const logger = makeLogger();

        await applySchema(db, idl, logger);

        expect(db.transaction).toHaveBeenCalledOnce();
    });

    it("queries pg_tables to verify tables were created", async () => {
        const idl = makeIdl({
            accounts: [{ name: "Offer", discriminator: [0, 0, 0, 0, 0, 0, 0, 0] }],
            types: [{ name: "Offer", type: { kind: "struct", fields: [] } }],
        });
        const db = makeDb(["_indexer_state", "acc_offer"]);
        const logger = makeLogger();

        await applySchema(db, idl, logger);

        // The verification SELECT must query pg_tables
        const verifySql: string = (db.query as ReturnType<typeof vi.fn>).mock.calls
            .map((call: unknown[]) => call[0] as string)
            .find((s: string) => s.includes("pg_tables")) ?? "";
        expect(verifySql).toContain("pg_tables");
        expect(verifySql).toContain("ANY($1)");
    });

    it("logs 'Table ready' for each verified table", async () => {
        const idl = makeIdl({
            instructions: [
                { name: "init", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const db = makeDb(["_indexer_state", "ix_init"]);
        const logger = makeLogger();

        await applySchema(db, idl, logger);

        const infoCalls: string[] = (logger.info as ReturnType<typeof vi.fn>).mock.calls
            .map((call: unknown[]) => (call[1] as string) ?? "")
            .filter(Boolean);

        expect(infoCalls.some((m: string) => m.includes("Table ready") || m.includes("Schema applied"))).toBe(true);
    });

    it("logs 'Table missing' when a table was not created", async () => {
        const idl = makeIdl({
            instructions: [
                { name: "missing_ix", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        // DB returns NO tables — simulates schema apply failure
        const db = makeDb([]);
        const logger = makeLogger();

        await applySchema(db, idl, logger);

        const warnCalls: string[] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
            .map((call: unknown[]) => (call[1] as string) ?? "");
        expect(warnCalls.some((m: string) => m.includes("missing"))).toBe(true);
    });

    it("propagates transaction errors", async () => {
        const idl = makeIdl({
            instructions: [
                { name: "transfer", discriminator: [0, 0, 0, 0, 0, 0, 0, 0], args: [], accounts: [] },
            ],
        });
        const db = makeDb();
        (db as unknown as Record<string, unknown>).transaction =
            vi.fn().mockRejectedValue(new Error("pg syntax error"));

        await expect(applySchema(db, idl, makeLogger())).rejects.toThrow("pg syntax error");
    });
});