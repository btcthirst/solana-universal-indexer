import {
    BorshInstructionCoder,
    BorshAccountsCoder,
} from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import type {
    ParsedTransactionWithMeta,
    TransactionInstruction,
    PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { ParsedIdl } from "../idl/types";
import bs58 from "bs58";
import BN from "bn.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DecodedInstruction {
    name: string;
    programId: string;
    args: Record<string, unknown>;
    accounts: string[];
    isInner: boolean;
}

// ─── Serialization ────────────────────────────────────────────────────────────
// BigInt → string, PublicKey → base58, Buffer → hex, recursive

function serializeValue(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof BN) return value.toString();
    if (value instanceof PublicKey) return value.toBase58();
    if (Buffer.isBuffer(value)) return value.toString("hex");
    if (Array.isArray(value)) return value.map(serializeValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                k,
                serializeValue(v),
            ])
        );
    }
    return value;
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, serializeValue(v)])
    );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createDecoder(parsedIdl: ParsedIdl, logger: Logger) {
    const idl = parsedIdl as unknown as Idl;
    const programId = new PublicKey(parsedIdl.address);

    const ixCoder = new BorshInstructionCoder(idl);
    const accCoder = new BorshAccountsCoder(idl);

    // Discriminator → account name map for O(1) lookup
    const discriminatorMap = new Map<string, string>();
    for (const acc of parsedIdl.accounts) {
        const key = Buffer.from(acc.discriminator).toString("hex");
        discriminatorMap.set(key, acc.name);
    }

    // ─── decodeInstruction ──────────────────────────────────────────────────────

    function decodeInstruction(
        ix: TransactionInstruction,
        isInner = false
    ): DecodedInstruction | null {
        if (!ix.programId.equals(programId)) return null;

        try {
            const decoded = ixCoder.decode(ix.data);
            if (!decoded) return null;

            return {
                name: decoded.name,
                programId: programId.toBase58(),
                args: serializeArgs(decoded.data as Record<string, unknown>),
                accounts: ix.keys.map((k) => k.pubkey.toBase58()),
                isInner,
            };
        } catch (err) {
            logger.warn({ err }, "Failed to decode instruction — skipping");
            return null;
        }
    }

    // ─── extractInstructions ────────────────────────────────────────────────────
    // Processes outer + inner (CPI) instructions

    function extractInstructions(
        tx: ParsedTransactionWithMeta
    ): DecodedInstruction[] {
        const results: DecodedInstruction[] = [];
        const outerIxs = tx.transaction.message.instructions;

        for (let i = 0; i < outerIxs.length; i++) {
            const raw = outerIxs[i];

            // System programs return a parsed object without a data field — skip them
            if (!raw || !("data" in raw)) continue;

            const partial = raw as PartiallyDecodedInstruction;
            const ix: TransactionInstruction = {
                programId: partial.programId,
                keys: partial.accounts.map((pk) => ({
                    pubkey: pk,
                    isSigner: false,
                    isWritable: false,
                })),
                data: Buffer.from(bs58.decode(partial.data)),
            };

            const decoded = decodeInstruction(ix, false);
            if (decoded) results.push(decoded);

            // Inner instructions (CPI calls)
            const innerGroup = tx.meta?.innerInstructions?.find((g) => g.index === i);
            if (!innerGroup) continue;

            for (const inner of innerGroup.instructions) {
                if (!("data" in inner)) continue;

                const innerPartial = inner as PartiallyDecodedInstruction;
                const innerIx: TransactionInstruction = {
                    programId: innerPartial.programId,
                    keys: innerPartial.accounts.map((pk) => ({
                        pubkey: pk,
                        isSigner: false,
                        isWritable: false,
                    })),
                    data: Buffer.from(bs58.decode(innerPartial.data)),
                };

                const decodedInner = decodeInstruction(innerIx, true);
                if (decodedInner) results.push(decodedInner);
            }
        }

        return results;
    }

    // ─── identifyAccountType ────────────────────────────────────────────────────

    function identifyAccountType(data: Buffer): string | null {
        if (data.length < 8) return null;
        const discriminator = data.subarray(0, 8).toString("hex");
        return discriminatorMap.get(discriminator) ?? null;
    }

    // ─── decodeAccount ──────────────────────────────────────────────────────────

    function decodeAccount(
        accountName: string,
        data: Buffer
    ): Record<string, unknown> | null {
        try {
            const decoded = accCoder.decode(accountName, data);
            if (!decoded) return null;
            return serializeArgs(decoded as Record<string, unknown>);
        } catch (err) {
            logger.warn({ err, accountName }, "Failed to decode account — skipping");
            return null;
        }
    }

    return { decodeInstruction, extractInstructions, identifyAccountType, decodeAccount };
}

export type Decoder = ReturnType<typeof createDecoder>;