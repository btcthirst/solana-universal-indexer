import { readFile } from "fs/promises";
import { z } from "zod";
import type { Logger } from "pino";
import type { ParsedIdl } from "./types";
import { Wallet } from "@coral-xyz/anchor";

// ─── Zod schema — validates raw JSON before mapping ─────────────────────────────
// Checks only top-level structure, not recursive field types —
// this is enough to ensure the IDL is workable

const idlSchema = z.object({
    address: z.string().min(1, "IDL must have a program address"),
    metadata: z.object({
        name: z.string(),
        version: z.string(),
        spec: z.string().optional(),
        description: z.string().optional(),
    }),
    instructions: z
        .array(
            z.object({
                name: z.string(),
                discriminator: z.array(z.number()).length(8),
                accounts: z.array(z.object({ name: z.string() })),
                args: z.array(z.object({ name: z.string(), type: z.unknown() })),
            })
        )
        .min(1, "IDL must have at least one instruction"),
    accounts: z.array(
        z.object({
            name: z.string(),
            discriminator: z.array(z.number()).length(8),
        })
    ),
    types: z
        .array(
            z.object({
                name: z.string(),
                type: z.object({ kind: z.enum(["struct", "enum"]) }),
            })
        )
        .optional()
        .default([]),
    events: z.array(z.object({ name: z.string() })).optional().default([]),
    errors: z
        .array(z.object({ code: z.number(), name: z.string() }))
        .optional()
        .default([]),
    constants: z
        .array(z.object({ name: z.string(), type: z.unknown(), value: z.string() }))
        .optional()
        .default([]),
});

type RawIdl = z.infer<typeof idlSchema>;

// ─── Mapper: RawIdl → ParsedIdl ───────────────────────────────────────────────

function mapIdl(raw: RawIdl, origin: "file" | "network", sourcePath?: string): ParsedIdl {
    return {
        address: raw.address,
        name: raw.metadata.name,
        version: raw.metadata.version,
        spec: raw.metadata.spec,
        description: raw.metadata.description,

        // Cast via unknown — detailed field typing is in types.ts,
        // Zod verified the structure above
        instructions: raw.instructions as unknown as ParsedIdl["instructions"],
        accounts: raw.accounts as unknown as ParsedIdl["accounts"],
        types: raw.types as unknown as ParsedIdl["types"],
        events: raw.events as unknown as ParsedIdl["events"],
        errors: raw.errors as unknown as ParsedIdl["errors"],
        constants: raw.constants as unknown as ParsedIdl["constants"],

        metadata: {
            origin,
            loadedAt: new Date().toISOString(),
            sourcePath,
        },
    };
}

// ─── Load from file ───────────────────────────────────────────────────────────

async function loadIdlFromFile(filePath: string, logger: Logger): Promise<ParsedIdl> {
    logger.info({ filePath }, "Loading IDL from file");

    let raw: unknown;
    try {
        const content = await readFile(filePath, "utf-8");
        raw = JSON.parse(content);
    } catch (err) {
        throw new Error(`Failed to read IDL file at "${filePath}": ${(err as Error).message}`);
    }

    const result = idlSchema.safeParse(raw);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(`IDL validation failed: ${issue?.message} (path: ${issue?.path.join(".")})`);
    }

    logger.info(
        { name: result.data.metadata.name, instructions: result.data.instructions.length },
        "IDL loaded from file"
    );

    return mapIdl(result.data, "file", filePath);
}

// ─── Load from network via Anchor fetchIdl ────────────────────────────────────

async function loadIdlFromNetwork(
    programId: string,
    rpcUrl: string,
    logger: Logger
): Promise<ParsedIdl> {
    logger.info({ programId, rpcUrl }, "Fetching IDL from network");

    // Dynamic import — @coral-xyz/anchor can be an optional dependency
    let anchor: typeof import("@coral-xyz/anchor");
    try {
        anchor = await import("@coral-xyz/anchor");
    } catch {
        throw new Error(
            "@coral-xyz/anchor is required to fetch IDL from network. Run: npm install @coral-xyz/anchor"
        );
    }

    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, {} as Wallet, {});

    const raw = await anchor.Program.fetchIdl(new PublicKey(programId), provider);
    if (!raw) {
        throw new Error(`No IDL found on-chain for program ${programId}`);
    }

    const result = idlSchema.safeParse(raw);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(`IDL validation failed: ${issue?.message} (path: ${issue?.path.join(".")})`);
    }

    logger.info(
        { programId, name: result.data.metadata.name },
        "IDL fetched from network"
    );

    return mapIdl(result.data, "network");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LoadIdlOptions {
    filePath?: string;
    programId?: string;
    rpcUrl?: string;
}

export async function loadIdl(opts: LoadIdlOptions, logger: Logger): Promise<ParsedIdl> {
    if (opts.filePath) {
        return loadIdlFromFile(opts.filePath, logger);
    }

    if (opts.programId && opts.rpcUrl) {
        return loadIdlFromNetwork(opts.programId, opts.rpcUrl, logger);
    }

    throw new Error(
        "loadIdl: provide either filePath or both programId + rpcUrl"
    );
}