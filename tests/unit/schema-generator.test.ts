import { describe, it, expect } from "vitest";
import { generateSchema } from "../../src/db/schema-generator";
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
            types: [{
                name: "Offer",
                type: { kind: "struct", fields: [] },
            }],
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
        // extract the string starting with arg_val ... from SQL
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

    it("option<T> → nullable (no NOT NULL)", () => {
        const sql = sqlFor({ option: "u64" });
        expect(sql).toContain("NUMERIC(40)");
        expect(sql).not.toContain("NOT NULL");
    });

    it("defined struct → JSONB", () => {
        expect(sqlFor({ defined: { name: "MyStruct" } })).toBe("JSONB");
    });

    it("array<T, N> → JSONB", () => {
        expect(sqlFor({ array: ["u8", 32] })).toBe("JSONB");
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
});