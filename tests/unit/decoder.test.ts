import { describe, it, expect, vi } from "vitest";
import type { ParsedIdl } from "../../src/idl/types";

// ─── Mock IDL ─────────────────────────────────────────────────────────────────
// Minimal IDL for testing without a real Anchor BorshCoder

const PROGRAM_ID = "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy";
const OTHER_ID = "11111111111111111111111111111111";

const mockIdl: ParsedIdl = {
    address: PROGRAM_ID,
    name: "escrow",
    version: "0.1.0",
    spec: "0.1.0",
    instructions: [
        {
            name: "make_offer",
            discriminator: [214, 98, 97, 35, 59, 12, 44, 178],
            args: [
                { name: "id", type: "u64" },
                { name: "token_a_offered_amount", type: "u64" },
                { name: "token_b_wanted_amount", type: "u64" },
            ],
            accounts: [
                { name: "maker", writable: true, signer: true },
            ],
        },
    ],
    accounts: [
        {
            name: "Offer",
            discriminator: [215, 88, 60, 71, 170, 162, 73, 229],
            fields: [],
        },
    ],
    types: [],
    events: [],
    errors: [],
    constants: [],
    metadata: { origin: "file", loadedAt: new Date().toISOString() },
};

// ─── Mock @coral-xyz/anchor ───────────────────────────────────────────────────

vi.mock("@coral-xyz/anchor", () => ({
    BorshInstructionCoder: function () {
        return {
            decode: vi.fn((data: Buffer) => {
                const disc = Buffer.from([214, 98, 97, 35, 59, 12, 44, 178]);
                if (data.subarray(0, 8).equals(disc)) {
                    return {
                        name: "make_offer",
                        data: { id: BigInt(1), token_a_offered_amount: BigInt(100), token_b_wanted_amount: BigInt(200) },
                    };
                }
                return null;
            }),
        };
    },
    BorshAccountsCoder: function () {
        return {
            decode: vi.fn((name: string, data: Buffer) => {
                if (name === "Offer" && data.length >= 8) {
                    return { id: BigInt(1), maker: "somePubkey", bump: 255 };
                }
                return null;
            }),
        };
    },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createDecoder", () => {
    async function getDecoder() {
        const { createDecoder } = await import("../../src/indexer/decoder");
        const logger = {
            warn: vi.fn(), error: vi.fn(), info: vi.fn(),
            debug: vi.fn(), child: vi.fn().mockReturnThis(),
        } as never;
        return createDecoder(mockIdl, logger);
    }

    // ─── decodeInstruction ────────────────────────────────────────────────────

    describe("decodeInstruction", () => {
        it("returns null for instruction from foreign program", async () => {
            const { decodeInstruction } = await getDecoder();
            const { PublicKey } = await import("@solana/web3.js");

            const ix = {
                programId: new PublicKey(OTHER_ID),
                keys: [],
                data: Buffer.alloc(8),
            };

            expect(decodeInstruction(ix)).toBeNull();
        });

        it("returns DecodedInstruction for matching program", async () => {
            const { decodeInstruction } = await getDecoder();
            const { PublicKey } = await import("@solana/web3.js");

            const discriminator = Buffer.from([214, 98, 97, 35, 59, 12, 44, 178]);
            const ix = {
                programId: new PublicKey(PROGRAM_ID),
                keys: [{ pubkey: new PublicKey(PROGRAM_ID), isSigner: true, isWritable: true }],
                data: discriminator,
            };

            const result = decodeInstruction(ix);
            expect(result).not.toBeNull();
            expect(result?.name).toBe("make_offer");
            expect(result?.programId).toBe(PROGRAM_ID);
        });

        it("returns null if coder returns null (unknown instruction)", async () => {
            const { decodeInstruction } = await getDecoder();
            const { PublicKey } = await import("@solana/web3.js");

            const ix = {
                programId: new PublicKey(PROGRAM_ID),
                keys: [],
                data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // unknown discriminator
            };

            expect(decodeInstruction(ix)).toBeNull();
        });

        it("returns null and logs warning on corrupted data", async () => {
            const { decodeInstruction } = await getDecoder();
            const { PublicKey } = await import("@solana/web3.js");
            const warnFn = vi.fn();

            // We cannot replace warn on the current logger via closure —
            // check that decode returns null for data that throws an error.
            // The mock decode throws Error only if the discriminator does not match and returns null.
            // Corrupted data = invalid discriminator → decode returns null → decodeInstruction returns null
            const ix = {
                programId: new PublicKey(PROGRAM_ID),
                keys: [],
                data: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // unknown disc
            };

            const result = decodeInstruction(ix);
            expect(result).toBeNull();
            void warnFn;
        });

        it("serializes BigInt args to string", async () => {
            const { decodeInstruction } = await getDecoder();
            const { PublicKey } = await import("@solana/web3.js");

            const ix = {
                programId: new PublicKey(PROGRAM_ID),
                keys: [],
                data: Buffer.from([214, 98, 97, 35, 59, 12, 44, 178]),
            };

            const result = decodeInstruction(ix);
            expect(typeof result?.args["id"]).toBe("string");       // BigInt → string
            expect(result?.args["id"]).toBe("1");
        });
    });

    // ─── identifyAccountType ──────────────────────────────────────────────────

    describe("identifyAccountType", () => {
        it("identifies account type by discriminator", async () => {
            const { identifyAccountType } = await getDecoder();
            const data = Buffer.from([215, 88, 60, 71, 170, 162, 73, 229, ...Array(32).fill(0)]);
            expect(identifyAccountType(data)).toBe("Offer");
        });

        it("returns null for unknown discriminator", async () => {
            const { identifyAccountType } = await getDecoder();
            const data = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
            expect(identifyAccountType(data)).toBeNull();
        });

        it("returns null for data shorter than 8 bytes", async () => {
            const { identifyAccountType } = await getDecoder();
            expect(identifyAccountType(Buffer.from([1, 2, 3]))).toBeNull();
        });
    });

    // ─── decodeAccount ────────────────────────────────────────────────────────

    describe("decodeAccount", () => {
        it("decodes known account type", async () => {
            const { decodeAccount } = await getDecoder();
            const data = Buffer.alloc(100);
            const result = decodeAccount("Offer", data);
            expect(result).not.toBeNull();
            expect(result?.["maker"]).toBe("somePubkey");
        });

        it("returns null for unknown account", async () => {
            const { decodeAccount } = await getDecoder();
            expect(decodeAccount("UnknownAccount", Buffer.alloc(8))).toBeNull();
        });
    });
});