import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Discriminator values confirmed against live BorshAccountsCoder.decode() test.

const PROGRAM_ID = "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy";
// sha256("account:Offer")[0..8] = [215,88,60,71,170,162,73,229]
const OFFER_DISC = Buffer.from([215, 88, 60, 71, 170, 162, 73, 229]);
// 113 bytes = 8 disc + 8 id + 32 maker + 32 mintA + 32 mintB + 8 wanted + 1 bump
const OFFER_DATA = Buffer.concat([OFFER_DISC, Buffer.alloc(105)]);

// Keys returned by BorshAccountsCoder.decode() for snake_case IDL fields
// are snake_case (confirmed by live test against Anchor v0.32).
const DECODED_OFFER: Record<string, unknown> = {
    id: "7",
    maker: "11111111111111111111111111111112",
    token_mint_a: "11111111111111111111111111111113",
    token_mint_b: "11111111111111111111111111111114",
    token_b_wanted_amount: "500000",
    bump: 253,
};

// ─── Mock factories ───────────────────────────────────────────────────────────

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
        metadata: { origin: "file" as const, loadedAt: "" },
    };
}

function makeLogger() {
    const l = {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        child: vi.fn(),
    };
    l.child.mockReturnValue(l);
    return l as never;
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

function makePk(s: string) { return { toBase58: () => s }; }

function makeRpc(
    accounts: Array<{ pubkey: { toBase58(): string }; account: { data: unknown; lamports: number } }> = [],
    slot = 300,
    accountInfoData: { data: unknown; lamports: number } | null = null
) {
    return {
        getProgramAccounts: vi.fn().mockResolvedValue(accounts),
        getSlot: vi.fn().mockResolvedValue(slot),
        connection: {
            getAccountInfo: vi.fn().mockResolvedValue(accountInfoData),
        },
    } as never;
}

// ─── sweepAccounts ────────────────────────────────────────────────────────────

describe("sweepAccounts", () => {
    beforeEach(() => vi.clearAllMocks());

    it("skips when IDL has no account types", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc();
        await sweepAccounts(makePk(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(false), makeDb(), makeLogger());
        expect(rpc.getProgramAccounts).not.toHaveBeenCalled();
    });

    it("calls getProgramAccounts with only the programId (no encoding option)", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([]);
        await sweepAccounts(makePk(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(), makeDb(), makeLogger());
        // Called with exactly one argument → no encoding config object
        expect(rpc.getProgramAccounts).toHaveBeenCalledWith(expect.objectContaining({ toBase58: expect.any(Function) }));
        expect(rpc.getProgramAccounts.mock.calls[0]).toHaveLength(1);
    });

    it("does nothing when program has zero on-chain accounts", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const decoder = makeDecoder();
        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc([]), decoder, makeIdl(), makeDb(), makeLogger());
        expect(decoder.identifyAccountType).not.toHaveBeenCalled();
    });

    it("identifies type by discriminator then decodes fields", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("OfferPDA1"), account: { data: OFFER_DATA, lamports: 1_000_000 } }];
        const decoder = makeDecoder();
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), decoder, makeIdl(), db, makeLogger());

        expect(decoder.identifyAccountType).toHaveBeenCalledWith(OFFER_DATA);
        expect(decoder.decodeAccount).toHaveBeenCalledWith("Offer", OFFER_DATA);
        expect(db.query).toHaveBeenCalled();
    });

    it("inserts into acc_offer (toSnake of 'Offer')", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("OfferPDA2"), account: { data: OFFER_DATA, lamports: 0 } }];
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), makeDecoder(), makeIdl(), db, makeLogger());

        const sql: string = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(sql).toMatch(/INSERT INTO acc_offer/i);
    });

    it("SQL contains all decoded field columns (snake_case)", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("OfferPDA3"), account: { data: OFFER_DATA, lamports: 0 } }];
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), makeDecoder(), makeIdl(), db, makeLogger());

        const sql: string = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
        for (const col of ["id", "maker", "token_mint_a", "token_mint_b", "token_b_wanted_amount", "bump"]) {
            expect(sql).toContain(col);
        }
    });

    it("values include pubkey, slot from getSlot(), and lamports", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("OfferPDA4"), account: { data: OFFER_DATA, lamports: 999 } }];
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts, 42_000), makeDecoder(), makeIdl(), db, makeLogger());

        const values: unknown[] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(values).toContain("OfferPDA4");   // pubkey
        expect(values).toContain(42_000);         // slot from getSlot()
        expect(values).toContain(999);            // lamports
    });

    it("skips accounts with fewer than 8 bytes of data", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("Short"), account: { data: Buffer.from([1, 2, 3]), lamports: 0 } }];
        const decoder = makeDecoder();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), decoder, makeIdl(), makeDb(), makeLogger());
        expect(decoder.identifyAccountType).not.toHaveBeenCalled();
    });

    it("skips accounts whose discriminator matches no IDL type", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const unknownData = Buffer.concat([Buffer.alloc(8), Buffer.alloc(32)]);
        const accounts = [{ pubkey: makePk("TokenAcc"), account: { data: unknownData, lamports: 0 } }];
        const decoder = makeDecoder({ identifyAccountType: vi.fn().mockReturnValue(null) });
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), decoder, makeIdl(), db, makeLogger());
        expect(decoder.decodeAccount).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it("warns and skips when decodeAccount returns null", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("CorruptPDA"), account: { data: OFFER_DATA, lamports: 0 } }];
        const decoder = makeDecoder({ decodeAccount: vi.fn().mockReturnValue(null) });
        const logger = makeLogger();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), decoder, makeIdl(), makeDb(), logger);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ accountType: "Offer" }),
            expect.any(String)
        );
    });

    it("accepts base64-encoded [string,'base64'] tuple from RPC", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{
            pubkey: makePk("Base64PDA"),
            account: { data: [OFFER_DATA.toString("base64"), "base64"] as [string, string], lamports: 100 },
        }];
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), makeDecoder(), makeIdl(), db, makeLogger());
        expect(db.query).toHaveBeenCalled();
    });

    it("continues processing after a single writeAccount failure", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [
            { pubkey: makePk("FailPDA"), account: { data: OFFER_DATA, lamports: 0 } },
            { pubkey: makePk("OkPDA"), account: { data: OFFER_DATA, lamports: 1 } },
        ];
        const db = makeDb();
        let insertCalls = 0;
        db.query = vi.fn().mockImplementation(async (sql: string) => {
            if (sql.includes("INSERT") && ++insertCalls === 1) throw new Error("constraint");
            return { rows: [] };
        });

        await expect(
            sweepAccounts(makePk(PROGRAM_ID) as never, makeRpc(accounts), makeDecoder(), makeIdl(), db, makeLogger())
        ).resolves.not.toThrow();
        expect(insertCalls).toBe(2);   // second account was still attempted
    });

    it("logs error and returns gracefully when getProgramAccounts throws", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const rpc = {
            getProgramAccounts: vi.fn().mockRejectedValue(new Error("RPC 429")),
            getSlot: vi.fn(),
            connection: { getAccountInfo: vi.fn() },
        } as never;
        const logger = makeLogger();

        await expect(
            sweepAccounts(makePk(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(), makeDb(), logger)
        ).resolves.not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.objectContaining({ message: "RPC 429" }) }),
            expect.stringContaining("getProgramAccounts failed")
        );
    });

    it("uses slot 0 and continues when getSlot throws", async () => {
        const { sweepAccounts } = await import("../../src/indexer/account-sweeper");
        const accounts = [{ pubkey: makePk("PDA"), account: { data: OFFER_DATA, lamports: 0 } }];
        const rpc = {
            getProgramAccounts: vi.fn().mockResolvedValue(accounts),
            getSlot: vi.fn().mockRejectedValue(new Error("timeout")),
            connection: { getAccountInfo: vi.fn() },
        } as never;
        const logger = makeLogger();
        const db = makeDb();

        await sweepAccounts(makePk(PROGRAM_ID) as never, rpc, makeDecoder(), makeIdl(), db, logger);

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
        expect(await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(false), makeDb(), 100, makeLogger())).toBe(false);
        expect(rpc.connection.getAccountInfo).not.toHaveBeenCalled();
    });

    it("returns false for an invalid base58 pubkey", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        expect(await sweepSingleAccount("not-valid!", makeRpc(), makeDecoder(), makeIdl(), makeDb(), 100, makeLogger())).toBe(false);
    });

    it("returns false when getAccountInfo returns null (account closed)", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        expect(await sweepSingleAccount(PROGRAM_ID, makeRpc(), makeDecoder(), makeIdl(), makeDb(), 100, makeLogger())).toBe(false);
    });

    it("returns true and writes on successful decode", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 1_000 });
        const db = makeDb();

        expect(await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 200, makeLogger())).toBe(true);
        expect(db.query).toHaveBeenCalled();
    });

    it("uses the slot passed by caller (not an RPC call)", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 999, { data: OFFER_DATA, lamports: 0 });
        const db = makeDb();

        await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 555, makeLogger());

        const values: unknown[] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(values).toContain(555);   // slot = argument, not rpc.getSlot()
    });

    it("returns false when discriminator does not match", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const decoder = makeDecoder({ identifyAccountType: vi.fn().mockReturnValue(null) });

        expect(await sweepSingleAccount(PROGRAM_ID, rpc, decoder, makeIdl(), makeDb(), 100, makeLogger())).toBe(false);
    });

    it("returns false when decodeAccount returns null", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const decoder = makeDecoder({ decodeAccount: vi.fn().mockReturnValue(null) });

        expect(await sweepSingleAccount(PROGRAM_ID, rpc, decoder, makeIdl(), makeDb(), 100, makeLogger())).toBe(false);
    });

    it("returns false and warns when getAccountInfo throws", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = {
            getProgramAccounts: vi.fn(),
            getSlot: vi.fn(),
            connection: { getAccountInfo: vi.fn().mockRejectedValue(new Error("net error")) },
        } as never;
        const logger = makeLogger();

        expect(await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(), makeDb(), 100, logger)).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ pubkey: PROGRAM_ID }),
            expect.stringContaining("getAccountInfo failed")
        );
    });

    it("returns false and warns when writeAccount throws", async () => {
        const { sweepSingleAccount } = await import("../../src/indexer/account-sweeper");
        const rpc = makeRpc([], 0, { data: OFFER_DATA, lamports: 0 });
        const db = makeDb();
        db.query = vi.fn().mockRejectedValue(new Error("unique_violation"));
        const logger = makeLogger();

        expect(await sweepSingleAccount(PROGRAM_ID, rpc, makeDecoder(), makeIdl(), db, 100, logger)).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ pubkey: PROGRAM_ID }),
            expect.stringContaining("writeAccount failed")
        );
    });
});