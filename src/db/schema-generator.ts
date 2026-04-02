import type { Logger } from "pino";
import type { DbClient } from "./client";
import type { ParsedIdl, AnchorType } from "../idl/types";

// ─── AnchorType → SQL ─────────────────────────────────────────────────────────

function anchorTypeToSql(type: AnchorType, nullable = false): string {
    const nn = nullable ? "" : " NOT NULL";

    if (typeof type === "string") {
        switch (type) {
            case "bool": return `BOOLEAN${nn}`;
            case "u8": case "u16": case "u32":
            case "i8": case "i16": case "i32": return `INTEGER${nn}`;
            case "u64": case "u128":
            case "i64": case "i128": return `NUMERIC(40)${nn}`;
            case "f32": case "f64": return `DOUBLE PRECISION${nn}`;
            case "pubkey": case "string": return `TEXT${nn}`;
            case "bytes": return `BYTEA${nn}`;
            default: return `TEXT${nn}`;
        }
    }

    // option<T> → nullable version of T
    if ("option" in type) return anchorTypeToSql(type.option, true);

    // vec, array, defined (struct/enum), coption → JSONB
    if ("vec" in type || "array" in type || "defined" in type || "coption" in type) {
        return `JSONB${nn}`;
    }

    return `TEXT${nn}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "");
}

type Field = ParsedIdl["instructions"][number]["args"][number];

// ─── DDL builders ─────────────────────────────────────────────────────────────

function buildInstructionTable(ixName: string, args: Field[]): string {
    const table = `ix_${toSnake(ixName)}`;

    // args nullable — transaction could have failed, arguments might not have been parsed
    const argCols = args.map((arg) => {
        const col = `arg_${toSnake(arg.name)}`.padEnd(24);
        const sqlType = anchorTypeToSql(arg.type, true); // always nullable
        return `  ${col} ${sqlType}`;
    });

    const cols = [
        "  id          BIGSERIAL    PRIMARY KEY",
        "  signature   TEXT         NOT NULL UNIQUE",
        "  slot        BIGINT       NOT NULL",
        "  block_time  TIMESTAMPTZ",
        "  success     BOOLEAN      NOT NULL",
        " caller      TEXT",
        ...argCols,
    ];

    return [
        `CREATE TABLE IF NOT EXISTS ${table} (`,
        cols.join(",\n"),
        ");",
        `CREATE INDEX IF NOT EXISTS idx_${table}_slot    ON ${table} (slot);`,
        `CREATE INDEX IF NOT EXISTS idx_${table}_success ON ${table} (success);`,
    ].join("\n");
}

function buildAccountTable(accName: string, fields: Field[]): string {
    const table = `acc_${toSnake(accName)}`;

    const fieldCols = (fields ?? []).map((f) => {
        const col = toSnake(f.name).padEnd(24);
        return `  ${col} ${anchorTypeToSql(f.type)}`;
    });

    const cols = [
        "  pubkey      TEXT         PRIMARY KEY",
        "  slot        BIGINT       NOT NULL",
        "  lamports    BIGINT",
        ...fieldCols,
    ];

    return [
        `CREATE TABLE IF NOT EXISTS ${table} (`,
        cols.join(",\n"),
        ");",
        `CREATE INDEX IF NOT EXISTS idx_${table}_slot ON ${table} (slot);`,
    ].join("\n");
}

function buildIndexerStateDDL(): string {
    return [
        "CREATE TABLE IF NOT EXISTS _indexer_state (",
        "  key              TEXT        NOT NULL,",
        "  program_id       TEXT        NOT NULL,",
        "  network          TEXT        NOT NULL,",
        "  last_slot        BIGINT,",
        "  last_signature   TEXT,",
        "  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
        "  PRIMARY KEY (key, program_id, network)",
        ");",
    ].join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SchemaResult {
    tables: string[];
    sql: string;
}

export function generateSchema(idl: ParsedIdl): SchemaResult {
    const blocks: string[] = [];
    const tables: string[] = [];

    // system table
    blocks.push(buildIndexerStateDDL());
    tables.push("_indexer_state");

    // ix_ tables
    for (const ix of idl.instructions) {
        blocks.push(buildInstructionTable(ix.name, ix.args));
        tables.push(`ix_${toSnake(ix.name)}`);
    }

    // acc_ tables — fields from idl.types (contains the full field structure)
    for (const acc of idl.accounts) {
        const typeDef = idl.types.find(
            (t) => t.name === acc.name && t.type.kind === "struct"
        );
        const fields: Field[] =
            typeDef?.type.kind === "struct"
                ? (typeDef.type.fields as Field[])
                : [];

        blocks.push(buildAccountTable(acc.name, fields));
        tables.push(`acc_${toSnake(acc.name)}`);
    }

    return {
        tables,
        sql: blocks.join("\n\n"),
    };
}

export async function applySchema(
    db: DbClient,
    idl: ParsedIdl,
    logger: Logger
): Promise<void> {
    const log = logger.child({ module: "schema-generator", program: idl.name });
    const { tables, sql } = generateSchema(idl);

    log.info({ tables }, "Applying schema...");

    await db.transaction(async (client) => {
        await client.query(sql);
    });

    // Verify which tables were actually created
    const result = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = ANY($1)`,
        [tables]
    );

    const existing = new Set(result.rows.map((r) => r.tablename));

    for (const table of tables) {
        if (existing.has(table)) {
            log.info({ table }, "Table ready");
        } else {
            log.warn({ table }, "Table missing after apply");
        }
    }

    log.info({ count: tables.length }, "Schema applied successfully");
}