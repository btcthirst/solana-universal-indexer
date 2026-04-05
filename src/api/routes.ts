import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { DbClient } from "../db/client";
import type { ParsedIdl } from "../idl/types";

// ─── Validation helpers ───────────────────────────────────────────────────────

function toSnake(name: string): string {
    return name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function validateQuery<T>(schema: z.ZodSchema<T>, query: unknown, reply: FastifyReply): T | null {
    const result = schema.safeParse(query);
    if (!result.success) {
        reply.status(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: result.error.issues[0]?.message ?? "Invalid query parameters",
        });
        return null;
    }
    return result.data;
}

// ─── Shared query schemas ─────────────────────────────────────────────────────

const paginationSchema = z.object({
    limit: z.coerce.number().min(1).max(1000).default(50),
    offset: z.coerce.number().min(0).default(0),
});

const instructionFilterSchema = paginationSchema.extend({
    slot_from: z.coerce.number().optional(),
    slot_to: z.coerce.number().optional(),
    success: z.enum(["true", "false"]).optional(),
});

const timeseriesSchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    interval: z.enum(["hour", "day", "week"]).default("day"),
});

const topCallersSchema = z.object({
    limit: z.coerce.number().min(1).max(100).default(10),
});

// ─── Route builder ────────────────────────────────────────────────────────────
//
// heavyMax and heavyWindow are forwarded from the rate-limit config in server.ts
// and applied to endpoints that run expensive aggregation queries. This keeps
// the rate-limit values in one place (env vars → server.ts) and avoids
// duplicating magic numbers here.

export async function registerRoutes(
    app: FastifyInstance,
    db: DbClient,
    idl: ParsedIdl,
    heavyMax = 50,
    heavyWindow = 60_000
): Promise<void> {

    const instructionNames = idl.instructions.map(i => i.name);
    const accountTypes = idl.accounts.map(a => a.name);

    // Shared route option for heavy aggregation endpoints.
    // @fastify/rate-limit reads config.rateLimit per-route.
    const heavyRateLimit = {
        config: {
            rateLimit: {
                max: heavyMax,
                timeWindow: heavyWindow,
            },
        },
    };

    // ─── GET / — self-documenting ─────────────────────────────────────────────

    app.get("/", async () => ({
        program: idl.name,
        programId: idl.address,
        version: idl.version,
        endpoints: [
            { method: "GET", path: "/health", description: "Health check" },
            { method: "GET", path: "/instructions/:name", description: "List instruction calls", params: "slot_from, slot_to, success, limit, offset" },
            { method: "GET", path: "/instructions/:name/:signature", description: "Single instruction call by signature" },
            { method: "GET", path: "/accounts/:type", description: "List accounts of type", params: "pubkey, limit, offset" },
            { method: "GET", path: "/accounts/:type/:pubkey", description: "Single account state" },
            { method: "GET", path: "/stats/instructions", description: "Aggregated stats per instruction" },
            { method: "GET", path: "/stats/instructions/:name/timeseries", description: "Calls over time", params: "from, to, interval (hour|day|week)", rateLimit: `${heavyMax}/min` },
            { method: "GET", path: "/stats/instructions/:name/top-callers", description: "Top caller addresses", params: "limit", rateLimit: `${heavyMax}/min` },
            { method: "GET", path: "/stats/program", description: "Overall program statistics", rateLimit: `${heavyMax}/min` },
        ],
        indexedInstructions: instructionNames,
        indexedAccountTypes: accountTypes,
    }));

    // ─── GET /instructions/:name ──────────────────────────────────────────────

    app.get("/instructions/:name", async (req: FastifyRequest, reply: FastifyReply) => {
        const { name } = req.params as { name: string };
        const table = `ix_${toSnake(name)}`;

        const query = validateQuery(instructionFilterSchema, req.query, reply);
        if (!query) return;

        const { limit, offset, slot_from, slot_to, success } = query;

        const conditions: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (slot_from !== undefined) { conditions.push(`slot >= $${idx++}`); values.push(slot_from); }
        if (slot_to !== undefined) { conditions.push(`slot <= $${idx++}`); values.push(slot_to); }
        if (success !== undefined) { conditions.push(`success = $${idx++}`); values.push(success === "true"); }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [dataResult, countResult] = await Promise.all([
            db.query(
                `SELECT * FROM ${table} ${where} ORDER BY slot DESC LIMIT $${idx++} OFFSET $${idx++}`,
                [...values, limit, offset]
            ),
            db.query<{ count: string }>(
                `SELECT COUNT(*) AS count FROM ${table} ${where}`,
                values
            ),
        ]);

        return {
            data: dataResult.rows,
            total: parseInt(countResult.rows[0]?.count ?? "0"),
            limit,
            offset,
        };
    });

    // ─── GET /instructions/:name/:signature ───────────────────────────────────

    app.get("/instructions/:name/:signature", async (req: FastifyRequest, reply: FastifyReply) => {
        const { name, signature } = req.params as { name: string; signature: string };
        const table = `ix_${toSnake(name)}`;

        const { rows } = await db.query(
            `SELECT * FROM ${table} WHERE signature = $1`,
            [signature]
        );

        if (rows.length === 0) {
            return reply.status(404).send({
                statusCode: 404,
                error: "Not Found",
                message: `Instruction '${name}' with signature '${signature}' not found`,
            });
        }

        return rows[0];
    });

    // ─── GET /accounts/:type ──────────────────────────────────────────────────

    app.get("/accounts/:type", async (req: FastifyRequest, reply: FastifyReply) => {
        const { type } = req.params as { type: string };
        const table = `acc_${toSnake(type)}`;

        const schema = paginationSchema.extend({
            pubkey: z.string().optional(),
        });

        const query = validateQuery(schema, req.query, reply);
        if (!query) return;

        const { limit, offset, pubkey } = query;

        const conditions: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (pubkey) { conditions.push(`pubkey = $${idx++}`); values.push(pubkey); }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const [dataResult, countResult] = await Promise.all([
            db.query(
                `SELECT * FROM ${table} ${where} ORDER BY slot DESC LIMIT $${idx++} OFFSET $${idx++}`,
                [...values, limit, offset]
            ),
            db.query<{ count: string }>(
                `SELECT COUNT(*) AS count FROM ${table} ${where}`,
                values
            ),
        ]);

        return {
            data: dataResult.rows,
            total: parseInt(countResult.rows[0]?.count ?? "0"),
            limit,
            offset,
        };
    });

    // ─── GET /accounts/:type/:pubkey ──────────────────────────────────────────

    app.get("/accounts/:type/:pubkey", async (req: FastifyRequest, reply: FastifyReply) => {
        const { type, pubkey } = req.params as { type: string; pubkey: string };
        const table = `acc_${toSnake(type)}`;

        const { rows } = await db.query(
            `SELECT * FROM ${table} WHERE pubkey = $1`,
            [pubkey]
        );

        if (rows.length === 0) {
            return reply.status(404).send({
                statusCode: 404,
                error: "Not Found",
                message: `Account '${type}' with pubkey '${pubkey}' not found`,
            });
        }

        return rows[0];
    });

    // ─── GET /stats/instructions ──────────────────────────────────────────────

    app.get("/stats/instructions", async () => {
        const stats: Record<string, unknown> = {};

        await Promise.all(
            instructionNames.map(async (name) => {
                const table = `ix_${toSnake(name)}`;
                const { rows } = await db.query<{
                    total: string;
                    success_count: string;
                    failed_count: string;
                    last_called: string | null;
                }>(
                    `SELECT
             COUNT(*)                          AS total,
             COUNT(*) FILTER (WHERE success)   AS success_count,
             COUNT(*) FILTER (WHERE NOT success) AS failed_count,
             MAX(block_time)                   AS last_called
           FROM ${table}`
                );

                const row = rows[0];
                stats[name] = {
                    total: parseInt(row?.total ?? "0"),
                    success: parseInt(row?.success_count ?? "0"),
                    failed: parseInt(row?.failed_count ?? "0"),
                    last_called: row?.last_called ?? null,
                };
            })
        );

        return stats;
    });

    // ─── GET /stats/instructions/:name/timeseries ─────────────────────────────
    // Heavy endpoint — tighter rate limit applied via heavyRateLimit.

    app.get("/stats/instructions/:name/timeseries", heavyRateLimit, async (req: FastifyRequest, reply: FastifyReply) => {
        const { name } = req.params as { name: string };
        const table = `ix_${toSnake(name)}`;

        const query = validateQuery(timeseriesSchema, req.query, reply);
        if (!query) return;

        const { from, to, interval } = query;

        const conditions: string[] = ["block_time IS NOT NULL"];
        const values: unknown[] = [];
        let idx = 1;

        if (from) { conditions.push(`block_time >= $${idx++}`); values.push(from); }
        if (to) { conditions.push(`block_time <= $${idx++}`); values.push(to); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const { rows } = await db.query<{
            period: string;
            count: string;
            success: string;
        }>(
            `SELECT
         DATE_TRUNC($${idx++}, block_time) AS period,
         COUNT(*)                          AS count,
         COUNT(*) FILTER (WHERE success)   AS success
       FROM ${table}
       ${where}
       GROUP BY period
       ORDER BY period ASC`,
            [...values, interval]
        );

        return rows.map(r => ({
            period: r.period,
            count: parseInt(r.count),
            success: parseInt(r.success),
        }));
    });

    // ─── GET /stats/instructions/:name/top-callers ────────────────────────────
    // Heavy endpoint — tighter rate limit applied via heavyRateLimit.

    app.get("/stats/instructions/:name/top-callers", heavyRateLimit, async (req: FastifyRequest, reply: FastifyReply) => {
        const { name } = req.params as { name: string };
        const table = `ix_${toSnake(name)}`;

        const query = validateQuery(topCallersSchema, req.query, reply);
        if (!query) return;

        const { rows } = await db.query<{ caller: string; count: string }>(
            `SELECT caller, COUNT(*) AS count
       FROM ${table}
       WHERE caller IS NOT NULL
       GROUP BY caller
       ORDER BY count DESC
       LIMIT $1`,
            [query.limit]
        );

        return rows.map(r => ({
            caller: r.caller,
            calls: parseInt(r.count),
        }));
    });

    // ─── GET /stats/program ───────────────────────────────────────────────────
    // Heavy endpoint — tighter rate limit applied via heavyRateLimit.

    app.get("/stats/program", heavyRateLimit, async () => {
        const txCounts = await Promise.all(
            instructionNames.map(name =>
                db.query<{ count: string; first: string | null; last: string | null }>(
                    `SELECT COUNT(*) AS count, MIN(block_time) AS first, MAX(block_time) AS last
           FROM ix_${toSnake(name)}`
                )
            )
        );

        const totalTransactions = txCounts.reduce(
            (sum, r) => sum + parseInt(r.rows[0]?.count ?? "0"), 0
        );

        const allFirstDates = txCounts.map(r => r.rows[0]?.first).filter(Boolean) as string[];
        const allLastDates = txCounts.map(r => r.rows[0]?.last).filter(Boolean) as string[];

        const accCounts = await Promise.all(
            accountTypes.map(type =>
                db.query<{ count: string }>(
                    `SELECT COUNT(*) AS count FROM acc_${toSnake(type)}`
                )
            )
        );

        const uniqueAccounts = accCounts.reduce(
            (sum, r) => sum + parseInt(r.rows[0]?.count ?? "0"), 0
        );

        return {
            programId: idl.address,
            name: idl.name,
            version: idl.version,
            network: idl.metadata?.origin,
            totalTransactions,
            uniqueAccounts,
            firstSeen: allFirstDates.length ? allFirstDates.sort()[0] : null,
            lastSeen: allLastDates.length ? allLastDates.sort().at(-1) : null,
            indexedInstructions: instructionNames,
            indexedAccountTypes: accountTypes,
        };
    });
}