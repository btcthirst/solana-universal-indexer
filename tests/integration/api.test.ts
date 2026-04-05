/**
 * Integration tests for the Fastify API layer.
 *
 * Strategy
 * ─────────
 * • We build the real Fastify app via createServer() — all routes, error handler,
 *   CORS, and schema validation run exactly as in production.
 * • The DB client is replaced with a lightweight in-memory mock so the tests
 *   need no running PostgreSQL instance and stay fast.
 * • The IDL is the real escrow IDL fixture, ensuring table-name generation,
 *   route params, and stat queries all reflect the actual program.
 *
 * Coverage
 * ─────────
 * GET /health
 * GET /
 * GET /instructions/:name
 * GET /instructions/:name/:signature
 * GET /accounts/:type
 * GET /accounts/:type/:pubkey
 * GET /stats/instructions
 * GET /stats/instructions/:name/timeseries
 * GET /stats/instructions/:name/top-callers
 * GET /stats/program
 * Error paths: 404, 400 bad query params
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/api/server";
import type { DbClient } from "../../src/db/client";
import type { ParsedIdl } from "../../src/idl/types";

// ─── IDL fixture ─────────────────────────────────────────────────────────────

const TEST_IDL: ParsedIdl = {
    address: "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy",
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
            accounts: [{ name: "maker", writable: true, signer: true }],
        },
        {
            name: "take_offer",
            discriminator: [128, 156, 242, 207, 237, 192, 103, 240],
            args: [],
            accounts: [{ name: "taker", writable: true, signer: true }],
        },
    ],
    accounts: [{ name: "Offer", discriminator: [215, 88, 60, 71, 170, 162, 73, 229] }],
    types: [],
    events: [],
    errors: [],
    constants: [],
    metadata: { origin: "file", loadedAt: new Date().toISOString() },
};

// ─── Sample row fixtures ──────────────────────────────────────────────────────

const SAMPLE_IX_ROW = {
    id: 1,
    signature: "5KtPmnABC123",
    slot: 305123456,
    block_time: "2024-11-20T10:00:00Z",
    success: true,
    caller: "7xK2MakerAddr",
    arg_id: "1",
    arg_token_a_offered_amount: "1000000",
    arg_token_b_wanted_amount: "2000000",
};

const SAMPLE_ACC_ROW = {
    pubkey: "OfferPDA123",
    slot: 305123456,
    lamports: 2039280,
    id: "1",
    maker: "7xK2MakerAddr",
    token_mint_a: "MintA111",
    token_mint_b: "MintB222",
    token_b_wanted_amount: "2000000",
    bump: 255,
};

// ─── Mock DB factory ──────────────────────────────────────────────────────────
//
// Each test configures what query() should return by overriding mockQueryImpl.
// The default returns an empty result set so tests that don't care don't fail.

let mockQueryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makeDb(): DbClient {
    return {
        pool: { end: vi.fn() } as never,
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) =>
            mockQueryImpl(sql, params)
        ),
        transaction: vi.fn().mockImplementation(
            async (fn: (c: { query: typeof vi.fn }) => Promise<unknown>) =>
                fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })
        ),
        checkDbConnection: vi.fn(),
    } as never;
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let app: FastifyInstance;
let db: DbClient;

beforeEach(async () => {
    mockQueryImpl = async () => ({ rows: [] });
    db = makeDb();
    app = await createServer(db, makePinoLogger(), TEST_IDL);
    await app.ready();
});

afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
});

function makePinoLogger() {
    const l = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
        level: "info",
        silent: vi.fn(),
    };
    l.child.mockReturnValue(l);
    return l as never;
}

// ─── GET /health ──────────────────────────────────────────────────────────────

describe("GET /health", () => {
    it("returns 200 with status ok when DB is reachable", async () => {
        mockQueryImpl = async (sql) => {
            if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
            if (sql.includes("_indexer_state")) return { rows: [{ last_signature: "5KtP..." }] };
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.status).toBe("ok");
        expect(body.dbConnected).toBe(true);
        expect(typeof body.uptime).toBe("number");
        expect(body.lastProcessedSignature).toBe("5KtP...");
    });

    it("returns 503 with status degraded when DB query fails", async () => {
        mockQueryImpl = async (sql) => {
            if (sql === "SELECT 1") throw new Error("Connection refused");
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(503);

        const body = res.json();
        expect(body.status).toBe("degraded");
        expect(body.dbConnected).toBe(false);
    });

    it("returns ok even when _indexer_state is missing (fresh install)", async () => {
        mockQueryImpl = async (sql) => {
            if (sql === "SELECT 1") return { rows: [{}] };
            if (sql.includes("_indexer_state")) throw new Error("relation does not exist");
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.json().lastProcessedSignature).toBeNull();
    });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe("GET /", () => {
    it("returns self-documenting endpoint list", async () => {
        const res = await app.inject({ method: "GET", url: "/" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.program).toBe("escrow");
        expect(body.programId).toBe(TEST_IDL.address);
        expect(Array.isArray(body.endpoints)).toBe(true);
        expect(body.indexedInstructions).toContain("make_offer");
        expect(body.indexedInstructions).toContain("take_offer");
        expect(body.indexedAccountTypes).toContain("Offer");
    });
});

// ─── GET /instructions/:name ──────────────────────────────────────────────────

describe("GET /instructions/:name", () => {
    it("returns paginated instruction rows with total count", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "16" }] };
            if (sql.includes("SELECT *")) return { rows: [SAMPLE_IX_ROW] };
            return { rows: [] };
        };

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?limit=10&offset=0",
        });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.total).toBe(16);
        expect(body.limit).toBe(10);
        expect(body.offset).toBe(0);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].signature).toBe("5KtPmnABC123");
    });

    it("applies slot_from and slot_to filters to SQL", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (sql, params) => {
            capturedParams.push(params ?? []);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?slot_from=300000000&slot_to=310000000",
        });
        expect(res.statusCode).toBe(200);

        // At least one query should include our slot filter values
        const hasSlotFilter = capturedParams.some(
            (p) => p.includes(300000000) && p.includes(310000000)
        );
        expect(hasSlotFilter).toBe(true);
    });

    it("applies success=true filter", async () => {
        const capturedSqls: string[] = [];
        mockQueryImpl = async (sql) => {
            capturedSqls.push(sql);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?success=true",
        });
        expect(res.statusCode).toBe(200);
        expect(capturedSqls.some((s) => s.includes("success"))).toBe(true);
    });

    it("returns 400 for invalid limit param", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?limit=notanumber",
        });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe("Bad Request");
    });

    it("returns 400 for limit > 1000", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?limit=9999",
        });
        expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid success value", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?success=maybe",
        });
        expect(res.statusCode).toBe(400);
    });

    it("uses correct table name for camelCase instruction", async () => {
        // take_offer stays take_offer — already snake_case
        const capturedSqls: string[] = [];
        mockQueryImpl = async (sql) => {
            capturedSqls.push(sql);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        await app.inject({ method: "GET", url: "/instructions/take_offer" });
        expect(capturedSqls.some((s) => s.includes("ix_take_offer"))).toBe(true);
    });

    it("returns empty data array when no rows exist", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/instructions/make_offer" });
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toEqual([]);
        expect(res.json().total).toBe(0);
    });
});

// ─── GET /instructions/:name/:signature ──────────────────────────────────────

describe("GET /instructions/:name/:signature", () => {
    it("returns single instruction row by signature", async () => {
        mockQueryImpl = async () => ({ rows: [SAMPLE_IX_ROW] });

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer/5KtPmnABC123",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().signature).toBe("5KtPmnABC123");
        expect(res.json().arg_id).toBe("1");
    });

    it("returns 404 when signature not found", async () => {
        mockQueryImpl = async () => ({ rows: [] });

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer/nonexistent",
        });
        expect(res.statusCode).toBe(404);
        const body = res.json();
        expect(body.statusCode).toBe(404);
        expect(body.error).toBe("Not Found");
    });
});

// ─── GET /accounts/:type ─────────────────────────────────────────────────────

describe("GET /accounts/:type", () => {
    it("returns paginated account rows", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "3" }] };
            if (sql.includes("SELECT *")) return { rows: [SAMPLE_ACC_ROW] };
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/accounts/Offer" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.total).toBe(3);
        expect(body.data[0].pubkey).toBe("OfferPDA123");
    });

    it("uses acc_offer table (toSnake of 'Offer')", async () => {
        const capturedSqls: string[] = [];
        mockQueryImpl = async (sql) => {
            capturedSqls.push(sql);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        await app.inject({ method: "GET", url: "/accounts/Offer" });
        expect(capturedSqls.some((s) => s.includes("acc_offer"))).toBe(true);
    });

    it("applies pubkey filter when provided", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (sql, params) => {
            capturedParams.push(params ?? []);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        await app.inject({
            method: "GET",
            url: "/accounts/Offer?pubkey=OfferPDA123",
        });

        const hasPublicKey = capturedParams.some((p) => p.includes("OfferPDA123"));
        expect(hasPublicKey).toBe(true);
    });

    it("returns 400 for negative offset", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/accounts/Offer?offset=-5",
        });
        expect(res.statusCode).toBe(400);
    });
});

// ─── GET /accounts/:type/:pubkey ─────────────────────────────────────────────

describe("GET /accounts/:type/:pubkey", () => {
    it("returns a single account by pubkey", async () => {
        mockQueryImpl = async () => ({ rows: [SAMPLE_ACC_ROW] });

        const res = await app.inject({
            method: "GET",
            url: "/accounts/Offer/OfferPDA123",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().pubkey).toBe("OfferPDA123");
        expect(res.json().maker).toBe("7xK2MakerAddr");
    });

    it("returns 404 when pubkey not found", async () => {
        mockQueryImpl = async () => ({ rows: [] });

        const res = await app.inject({
            method: "GET",
            url: "/accounts/Offer/unknownPubkey",
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("Not Found");
    });
});

// ─── GET /stats/instructions ─────────────────────────────────────────────────

describe("GET /stats/instructions", () => {
    it("returns aggregated stats for each IDL instruction", async () => {
        mockQueryImpl = async () => ({
            rows: [
                {
                    total: "16",
                    success_count: "14",
                    failed_count: "2",
                    last_called: "2024-11-20T10:00:00Z",
                },
            ],
        });

        const res = await app.inject({ method: "GET", url: "/stats/instructions" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        // Both instructions in the IDL should appear
        expect(body).toHaveProperty("make_offer");
        expect(body).toHaveProperty("take_offer");

        const mo = body.make_offer;
        expect(mo.total).toBe(16);
        expect(mo.success).toBe(14);
        expect(mo.failed).toBe(2);
        expect(mo.last_called).toBe("2024-11-20T10:00:00Z");
    });

    it("returns zero counts when table is empty", async () => {
        mockQueryImpl = async () => ({
            rows: [{ total: "0", success_count: "0", failed_count: "0", last_called: null }],
        });

        const res = await app.inject({ method: "GET", url: "/stats/instructions" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.make_offer.total).toBe(0);
        expect(body.make_offer.last_called).toBeNull();
    });
});

// ─── GET /stats/instructions/:name/timeseries ─────────────────────────────────

describe("GET /stats/instructions/:name/timeseries", () => {
    it("returns timeseries rows with parsed count and success", async () => {
        mockQueryImpl = async () => ({
            rows: [
                { period: "2024-11-20T00:00:00.000Z", count: "8", success: "7" },
                { period: "2024-11-21T00:00:00.000Z", count: "12", success: "12" },
            ],
        });

        const res = await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/timeseries?interval=day",
        });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(2);
        expect(body[0].count).toBe(8);
        expect(body[0].success).toBe(7);
        expect(body[1].count).toBe(12);
    });

    it("defaults to day interval when not specified", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (_, params) => {
            capturedParams.push(params ?? []);
            return { rows: [] };
        };

        await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/timeseries",
        });

        const hasDay = capturedParams.some((p) => p.includes("day"));
        expect(hasDay).toBe(true);
    });

    it("accepts from/to date range params", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (_, params) => {
            capturedParams.push(params ?? []);
            return { rows: [] };
        };

        await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/timeseries?from=2024-11-01&to=2024-11-30&interval=hour",
        });

        const hasFrom = capturedParams.some((p) => p.includes("2024-11-01"));
        const hasTo = capturedParams.some((p) => p.includes("2024-11-30"));
        const hasHour = capturedParams.some((p) => p.includes("hour"));
        expect(hasFrom && hasTo && hasHour).toBe(true);
    });

    it("returns 400 for invalid interval value", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/timeseries?interval=month",
        });
        expect(res.statusCode).toBe(400);
    });
});

// ─── GET /stats/instructions/:name/top-callers ───────────────────────────────

describe("GET /stats/instructions/:name/top-callers", () => {
    it("returns top callers sorted by call count", async () => {
        mockQueryImpl = async () => ({
            rows: [
                { caller: "7xK2MakerAddr", count: "10" },
                { caller: "AbC9OtherAddr", count: "3" },
            ],
        });

        const res = await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/top-callers",
        });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body[0].caller).toBe("7xK2MakerAddr");
        expect(body[0].calls).toBe(10);
        expect(body[1].calls).toBe(3);
    });

    it("respects limit query param", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (_, params) => {
            capturedParams.push(params ?? []);
            return { rows: [] };
        };

        await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/top-callers?limit=5",
        });

        const hasLimit = capturedParams.some((p) => p.includes(5));
        expect(hasLimit).toBe(true);
    });

    it("returns 400 for limit > 100", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/top-callers?limit=999",
        });
        expect(res.statusCode).toBe(400);
    });

    it("returns empty array when no callers found", async () => {
        mockQueryImpl = async () => ({ rows: [] });

        const res = await app.inject({
            method: "GET",
            url: "/stats/instructions/make_offer/top-callers",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual([]);
    });
});

// ─── GET /stats/program ──────────────────────────────────────────────────────

describe("GET /stats/program", () => {
    it("returns overall program statistics", async () => {
        let callCount = 0;
        mockQueryImpl = async (sql) => {
            callCount++;
            // ix_ stats queries (2 instructions)
            if (sql.includes("ix_make_offer") || sql.includes("ix_take_offer")) {
                return {
                    rows: [{ count: "10", first: "2024-11-15T08:00:00Z", last: "2024-11-20T10:00:00Z" }],
                };
            }
            // acc_ stats queries (1 account type)
            if (sql.includes("acc_offer")) {
                return { rows: [{ count: "3" }] };
            }
            return { rows: [{ count: "0", first: null, last: null }] };
        };

        const res = await app.inject({ method: "GET", url: "/stats/program" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.programId).toBe(TEST_IDL.address);
        expect(body.name).toBe("escrow");
        expect(body.totalTransactions).toBe(20); // 10 make_offer + 10 take_offer
        expect(body.uniqueAccounts).toBe(3);
        expect(body.firstSeen).toBe("2024-11-15T08:00:00Z");
        expect(body.lastSeen).toBe("2024-11-20T10:00:00Z");
        expect(body.indexedInstructions).toContain("make_offer");
        expect(body.indexedAccountTypes).toContain("Offer");
    });

    it("returns null firstSeen/lastSeen when no data", async () => {
        mockQueryImpl = async () => ({
            rows: [{ count: "0", first: null, last: null }],
        });

        const res = await app.inject({ method: "GET", url: "/stats/program" });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        expect(body.firstSeen).toBeNull();
        expect(body.lastSeen).toBeNull();
        expect(body.totalTransactions).toBe(0);
    });
});

// ─── Global error handler ─────────────────────────────────────────────────────

describe("Global error handler", () => {
    it("returns 500 JSON on unexpected DB error from instruction route", async () => {
        mockQueryImpl = async () => {
            throw new Error("unexpected pg error");
        };

        const res = await app.inject({ method: "GET", url: "/instructions/make_offer" });
        // Fastify will catch the error and call our error handler
        expect(res.statusCode).toBe(500);
        const body = res.json();
        expect(body.statusCode).toBe(500);
        expect(body.error).toBe("Internal Server Error");
    });

    it("returns JSON error (not HTML) for 500 responses", async () => {
        mockQueryImpl = async () => { throw new Error("DB down"); };

        const res = await app.inject({ method: "GET", url: "/instructions/make_offer" });
        expect(res.headers["content-type"]).toMatch(/application\/json/);
    });
});

// ─── CORS ────────────────────────────────────────────────────────────────────

describe("CORS headers", () => {
    it("includes Access-Control-Allow-Origin on responses", async () => {
        mockQueryImpl = async () => ({ rows: [] });
        const res = await app.inject({
            method: "GET",
            url: "/",
            headers: { origin: "https://example.com" },
        });
        expect(res.headers["access-control-allow-origin"]).toBeDefined();
    });
});

// ─── Pagination edge cases ────────────────────────────────────────────────────

describe("Pagination edge cases", () => {
    it("defaults limit to 50 and offset to 0 when not provided", async () => {
        const capturedParams: unknown[][] = [];
        mockQueryImpl = async (sql, params) => {
            capturedParams.push(params ?? []);
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        await app.inject({ method: "GET", url: "/instructions/make_offer" });

        // The SELECT query should have 50 and 0 as the last two params (limit, offset)
        const selectParams = capturedParams.find(
            (p) => p.includes(50) && p.includes(0)
        );
        expect(selectParams).toBeDefined();
    });

    it("accepts max limit of 1000 without error", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const res = await app.inject({
            method: "GET",
            url: "/instructions/make_offer?limit=1000",
        });
        expect(res.statusCode).toBe(200);
    });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe("Rate limiting", () => {
    // The test app is created with default env (no RATE_LIMIT_MAX set),
    // so max=200 and heavyMax=50. We verify headers and 429 behaviour
    // without actually exhausting the limit (that would be slow).

    it("includes X-RateLimit-Limit header on standard endpoints", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const res = await app.inject({ method: "GET", url: "/instructions/make_offer" });
        expect(res.statusCode).toBe(200);
        expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    });

    it("includes X-RateLimit-Remaining header and decrements it", async () => {
        mockQueryImpl = async (sql) => {
            if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
            return { rows: [] };
        };

        const first = await app.inject({ method: "GET", url: "/accounts/Offer" });
        const second = await app.inject({ method: "GET", url: "/accounts/Offer" });

        const remaining1 = parseInt(first.headers["x-ratelimit-remaining"] as string);
        const remaining2 = parseInt(second.headers["x-ratelimit-remaining"] as string);

        expect(remaining1).toBeGreaterThan(remaining2);
    });

    it("includes X-RateLimit-Reset header", async () => {
        mockQueryImpl = async () => ({ rows: [] });

        const res = await app.inject({ method: "GET", url: "/" });
        expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("heavy endpoints have a lower X-RateLimit-Limit than standard ones", async () => {
        mockQueryImpl = async () => ({ rows: [] });

        const standard = await app.inject({ method: "GET", url: "/instructions/make_offer" });
        const heavy = await app.inject({ method: "GET", url: "/stats/program" });

        const standardLimit = parseInt(standard.headers["x-ratelimit-limit"] as string);
        const heavyLimit = parseInt(heavy.headers["x-ratelimit-limit"] as string);

        // heavyMax = floor(max / 4), so heavy limit must be strictly less
        expect(heavyLimit).toBeLessThan(standardLimit);
    });

    it("returns 429 with JSON body when rate limit is exceeded", async () => {
        // Build a fresh app with max=1 so we hit the limit on the second request
        const tightApp = await createServer(
            makeDb(),
            makePinoLogger(),
            TEST_IDL,
            // heavyMax and heavyWindow don't matter here — we test the standard limit
            // by setting RATE_LIMIT_MAX via env before createServer reads it
        );

        // Override env for this test only
        const original = process.env["RATE_LIMIT_MAX"];
        process.env["RATE_LIMIT_MAX"] = "1";

        const tightApp2 = await createServer(makeDb(), makePinoLogger(), TEST_IDL);
        await tightApp2.ready();

        // First request — should pass
        const first = await tightApp2.inject({ method: "GET", url: "/" });
        expect(first.statusCode).toBe(200);

        // Second request — should be rate limited
        const second = await tightApp2.inject({ method: "GET", url: "/" });
        expect(second.statusCode).toBe(429);

        const body = second.json();
        expect(body.statusCode).toBe(429);
        expect(body.error).toBe("Too Many Requests");
        expect(body.message).toMatch(/Rate limit exceeded/);

        // Cleanup
        process.env["RATE_LIMIT_MAX"] = original;
        await tightApp.close();
        await tightApp2.close();
    });

    it("/health endpoint is exempt from rate limiting", async () => {
        // Even with max=1, /health should never return 429
        const original = process.env["RATE_LIMIT_MAX"];
        process.env["RATE_LIMIT_MAX"] = "1";

        mockQueryImpl = async (sql) => {
            if (sql === "SELECT 1") return { rows: [{}] };
            if (sql.includes("_indexer_state")) throw new Error("not created yet");
            return { rows: [] };
        };

        const tightApp = await createServer(makeDb(), makePinoLogger(), TEST_IDL);
        await tightApp.ready();

        // Fire three requests — all should return 200 or 503, never 429
        for (let i = 0; i < 3; i++) {
            const res = await tightApp.inject({ method: "GET", url: "/health" });
            expect(res.statusCode).not.toBe(429);
        }

        process.env["RATE_LIMIT_MAX"] = original;
        await tightApp.close();
    });

    it("429 response is JSON not HTML", async () => {
        const original = process.env["RATE_LIMIT_MAX"];
        process.env["RATE_LIMIT_MAX"] = "1";

        const tightApp = await createServer(makeDb(), makePinoLogger(), TEST_IDL);
        await tightApp.ready();

        await tightApp.inject({ method: "GET", url: "/" }); // consume the limit
        const res = await tightApp.inject({ method: "GET", url: "/" });

        expect(res.statusCode).toBe(429);
        expect(res.headers["content-type"]).toMatch(/application\/json/);

        process.env["RATE_LIMIT_MAX"] = original;
        await tightApp.close();
    });
});