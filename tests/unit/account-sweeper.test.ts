import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PROGRAM_ID = "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy";
const OFFER_DISC = Buffer.from([215, 88, 60, 71, 170, 162, 73, 229]);
const OFFER_DATA = Buffer.concat([OFFER_DISC, Buffer.alloc(64)]);
const DECODED_OFFER = {
    id: "1",
    maker: "MakerPubkey111111111111111111111111111111111",
    token_mint_a: "MintA111111111111111111111111111111111111111",
    token_mint_b: "MintB111111111111111111111111111111111111111",
    token_b_wanted_amount: "2000000",
    bump: 255,
};

function makeIdl(hasAccounts = true) {
    return {
        address: PROGRAM_ID,
        name: "escrow",
        version: "0.1.0",
        instructions: [],
        accounts: hasAccounts
            ? [{ name: "Offer", discriminator: [215, 88, 60, 71, 170, 162, 73, 229] }]
            : [],
        types: [],
        events: [],
        errors: [],
        constants: [],
        metadata: { origin: "file" as const, loadedAt: new Date().toISOString() },
    };
}

function makeLogger() {
    return {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
        debug: vi.fn(), child: vi.fn().mockReturnThis(),
    } as never;
}

function makeDecoder(overrides: Record<string, unknown> = {}) {
    return {
        identifyAccountType: vi.fn().mockReturnValue("Offer"),
        decodeAccount: vi.fn().mockReturnValue({ ...DECODED_OFFER }),
        decodeInstruction: vi.fn().mockReturnValue(null),
        extractInstructions: vi.fn().mockReturnValue([]),
        ...overrides,
    } as never;
}

function makeDb() {
    return {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        transaction: vi.fn().mockImplementation(
            async (fn: (c: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
                fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })
        ),
        pool: { end: vi.fn() },
        checkDbConnection: vi.fn(),
    } as never;
}

function makePubkey(str: string) {
    return { toBase58: () => str };
}

function makeRpc(
    accounts: Array<{ pubkey: ReturnType<typeof makePubkey>; account: { data: unknown; lamports: number } }> = [],
    slot = 300,
    accountInfo: { data: unknown; lamports: number } | null = null
) {
    return {
        getProgramAccounts: vi.fn().mockResolvedValue(accounts),
        getSlot: vi.fn().mockResolvedValue(slot),
        connection: {
            getAccountInfo: vi.fn().mockResolvedValue(accountInfo),
        },
    } as never;
}

// ─── sweepAccounts ────────────────────────────────────────────────────────────

describe("sweepAccounts", () => {
    beforeEach(() => vi.clearAllMocks());

    it("skips sweep when IDL has no account types", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc();
        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, rpc,
            makeDecoder(), makeIdl(false), makeDb(), makeLogger()
        );
        expect(rpc.getProgramAccounts).not.toHaveBeenCalled();
    });

    it("calls getProgramAccounts without encoding (returns Buffer directly)", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([]);
        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, rpc,
            makeDecoder(), makeIdl(), makeDb(), makeLogger()
        );
        // Called with no second argument (no encoding option)
        expect(rpc.getProgramAccounts).toHaveBeenCalledWith(
            expect.anything()   // just the programId, no config
        );
    });

    it("does nothing when program has zero on-chain accounts", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const decoder = makeDecoder();
        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc([]),
            decoder, makeIdl(), makeDb(), makeLogger()
        );
        expect(decoder.identifyAccountType).not.toHaveBeenCalled();
    });

    it("identifies type by discriminator and decodes fields", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("OfferPDA111"), account: { data: OFFER_DATA, lamports: 1_000_000 } },
        ];
        const decoder = makeDecoder();
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            decoder, makeIdl(), db, makeLogger()
        );

        expect(decoder.identifyAccountType).toHaveBeenCalledWith(OFFER_DATA);
        expect(decoder.decodeAccount).toHaveBeenCalledWith("Offer", OFFER_DATA);
        expect(db.query).toHaveBeenCalled();
    });

    it("writes to acc_offer table (snake_case of 'Offer')", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("OfferPDA222"), account: { data: OFFER_DATA, lamports: 500_000 } },
        ];
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            makeDecoder(), makeIdl(), db, makeLogger()
        );

        const sql: string = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(sql).toMatch(/INSERT INTO acc_offer/i);
    });

    it("writes pubkey, slot from getSlot(), and lamports", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("OfferPDA333"), account: { data: OFFER_DATA, lamports: 999 } },
        ];
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts, 42_000),
            makeDecoder(), makeIdl(), db, makeLogger()
        );

        const values: unknown[] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(values).toContain("OfferPDA333");   // pubkey
        expect(values).toContain(42_000);           // slot from getSlot()
        expect(values).toContain(999);              // lamports
    });

    it("skips accounts with data shorter than 8 bytes", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("Short"), account: { data: Buffer.from([1, 2, 3]), lamports: 0 } },
        ];
        const decoder = makeDecoder();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            decoder, makeIdl(), makeDb(), makeLogger()
        );

        expect(decoder.identifyAccountType).not.toHaveBeenCalled();
    });

    it("skips accounts whose discriminator matches no IDL type", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const unknown = Buffer.concat([Buffer.alloc(8), Buffer.alloc(32)]);
        const accounts = [
            { pubkey: makePubkey("TokenAcc"), account: { data: unknown, lamports: 0 } },
        ];
        const decoder = makeDecoder({ identifyAccountType: vi.fn().mockReturnValue(null) });
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            decoder, makeIdl(), db, makeLogger()
        );

        expect(decoder.decodeAccount).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it("skips and warns when decodeAccount returns null", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("CorruptPDA"), account: { data: OFFER_DATA, lamports: 0 } },
        ];
        const decoder = makeDecoder({ decodeAccount: vi.fn().mockReturnValue(null) });
        const logger = makeLogger();
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            decoder, makeIdl(), db, logger
        );

        expect(db.query).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ accountType: "Offer" }),
            expect.any(String)
        );
    });

    it("handles base64-encoded data [string, 'base64'] tuple", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            {
                pubkey: makePubkey("Base64PDA"),
                account: { data: [OFFER_DATA.toString("base64"), "base64"], lamports: 100 },
            },
        ];
        const decoder = makeDecoder();
        const db = makeDb();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
            decoder, makeIdl(), db, makeLogger()
        );

        // Should still decode and write
        expect(decoder.identifyAccountType).toHaveBeenCalled();
        expect(db.query).toHaveBeenCalled();
    });

    it("continues after a single writeAccount failure", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("FailPDA"), account: { data: OFFER_DATA, lamports: 0 } },
            { pubkey: makePubkey("OkPDA"), account: { data: OFFER_DATA, lamports: 500 } },
        ];
        const db = makeDb();
        let calls = 0;
        db.query = vi.fn().mockImplementation(async (sql: string) => {
            if (sql.includes("INSERT") && ++calls === 1) throw new Error("DB write failed");
            return { rows: [] };
        });

        await expect(
            sweepAccounts(
                makePubkey(PROGRAM_ID) as never, makeRpc(accounts),
                makeDecoder(), makeIdl(), db, makeLogger()
            )
        ).resolves.not.toThrow();

        // Second account should still have been attempted (calls = 2)
        expect(calls).toBe(2);
    });

    it("logs error and returns gracefully when getProgramAccounts throws", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = {
            getProgramAccounts: vi.fn().mockRejectedValue(new Error("RPC 429")),
            getSlot: vi.fn().mockResolvedValue(0),
            connection: { getAccountInfo: vi.fn() },
        } as never;
        const logger = makeLogger();

        await expect(
            sweepAccounts(makePubkey(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(), makeDb(), logger)
        ).resolves.not.toThrow();

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.objectContaining({ message: "RPC 429" }) }),
            expect.stringContaining("getProgramAccounts failed")
        );
    });

    it("uses slot 0 and continues when getSlot throws", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePubkey("SlotFailPDA"), account: { data: OFFER_DATA, lamports: 0 } },
        ];
        const rpc = {
            getProgramAccounts: vi.fn().mockResolvedValue(accounts),
            getSlot: vi.fn().mockRejectedValue(new Error("timeout")),
            connection: { getAccountInfo: vi.fn() },
        } as never;
        const db = makeDb();
        const logger = makeLogger();

        await sweepAccounts(
            makePubkey(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(), db, logger
        );

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not fetch current slot"));
        const values: unknown[] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(values).toContain(0);   // slot defaults to 0
    });
});

// ─── sweepSingleAccount ───────────────────────────────────────────────────────

describe("sweepSingleAccount", () => {
    beforeEach(() => vi.clearAllMocks());

    it("returns false immediately when IDL has no account types", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc();
        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, makeDecoder(), makeIdl(false), makeDb(), 100, makeLogger()
        );
        expect(result).toBe(false);
        expect(rpc.connection.getAccountInfo).not.toHaveBeenCalled();
    });

    it("returns false when getAccountInfo returns null (account closed)", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const result = await sweepSingleAccount(
            PROGRAM_ID, makeRpc(), makeDecoder(), makeIdl(), makeDb(), 100, makeLogger()
        );
        expect(result).toBe(false);
    });

    it("returns false for invalid pubkey string", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const result = await sweepSingleAccount(
            "not-a-valid-pubkey", makeRpc(), makeDecoder(), makeIdl(), makeDb(), 100, makeLogger()
        );
        expect(result).toBe(false);
    });

    it("returns true and writes on successful decode", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 1_000 });
        const db = makeDb();

        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 200, makeLogger()
        );

        expect(result).toBe(true);
        expect(db.query).toHaveBeenCalled();
    });

    it("passes the provided slot (not getSlot) to writeAccount", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const db = makeDb();

        await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 555, makeLogger());

        const values: unknown[] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(values).toContain(555);
    });

    it("returns false when discriminator does not match", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const decoder = makeDecoder({ identifyAccountType: vi.fn().mockReturnValue(null) });
        const db = makeDb();

        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, decoder, makeIdl(), db, 100, makeLogger()
        );

        expect(result).toBe(false);
        expect(db.query).not.toHaveBeenCalled();
    });

    it("returns false when decodeAccount returns null", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const decoder = makeDecoder({ decodeAccount: vi.fn().mockReturnValue(null) });

        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, decoder, makeIdl(), makeDb(), 100, makeLogger()
        );

        expect(result).toBe(false);
    });

    it("returns false when getAccountInfo throws", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = {
            getProgramAccounts: vi.fn(),
            getSlot: vi.fn(),
            connection: {
                getAccountInfo: vi.fn().mockRejectedValue(new Error("network error")),
            },
        } as never;
        const logger = makeLogger();

        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, makeDecoder(), makeIdl(), makeDb(), 100, logger
        );

        expect(result).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ pubkey: PROGRAM_ID }),
            expect.stringContaining("getAccountInfo failed")
        );
    });

    it("returns false when writeAccount throws", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const db = makeDb();
        db.query = vi.fn().mockRejectedValue(new Error("constraint violation"));

        const result = await sweepSingleAccount(
            PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 100, makeLogger()
        );

        expect(result).toBe(false);
    });
});