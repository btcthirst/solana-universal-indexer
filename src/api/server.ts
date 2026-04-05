import Fastify, { FastifyError, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "pino";
import type { DbClient } from "../db/client";
import { registerRoutes } from "./routes";
import { ParsedIdl } from "../idl/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServerOptions {
    port: number;
    host?: string;
    programId: string;
    network: string;
}

// ─── Rate limit config ────────────────────────────────────────────────────────
// Reads from environment so operators can tune without code changes:
//   RATE_LIMIT_MAX        — requests per window for standard endpoints (default 200)
//   RATE_LIMIT_WINDOW_MS  — window size in milliseconds (default 60000 = 1 minute)
//
// Heavy aggregation endpoints (timeseries, top-callers, /stats/*) use a
// tighter limit of RATE_LIMIT_MAX / 4 to protect expensive DB queries.

function getRateLimitConfig() {
    const max = parseInt(process.env["RATE_LIMIT_MAX"] ?? "200", 10);
    const windowMs = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] ?? "60000", 10);
    const heavyMax = Math.max(1, Math.floor(max / 4));
    return { max, windowMs, heavyMax };
}

// ─── createServer ─────────────────────────────────────────────────────────────

export async function createServer(db: DbClient, logger: Logger, idl: ParsedIdl) {
    const app = Fastify({
        loggerInstance: logger,
        disableRequestLogging: false,
    });

    // ─── CORS ─────────────────────────────────────────────────────────────────

    await app.register(cors, {
        origin: true,   // replace with specific domains in prod
    });

    // ─── Rate limiting ────────────────────────────────────────────────────────
    // Applied globally; individual routes can tighten via:
    //   { config: { rateLimit: { max: N, timeWindow: Ms } } }
    //
    // In-memory store (default) works for single-instance deployments.
    // For multi-instance, swap in a Redis store:
    //   import Redis from "ioredis";
    //   store: new RedisStore({ client: new Redis() })

    const { max, windowMs, heavyMax } = getRateLimitConfig();

    await app.register(rateLimit, {
        global: true,
        max,
        timeWindow: windowMs,
        // Rate limit by IP. Behind a reverse proxy set trustProxy so req.ip
        // reflects the real client address rather than the proxy's.
        keyGenerator: (req: FastifyRequest) =>
            req.ip ?? req.socket?.remoteAddress ?? "unknown",
        errorResponseBuilder: (_req: FastifyRequest, context) => ({
            statusCode: 429,
            error: "Too Many Requests",
            message: `Rate limit exceeded. Retry in ${context.after}.`,
        }),
        // Skip rate limiting for /health — load balancers and uptime monitors
        // poll it continuously from fixed IPs and must never receive 429.
        // allowList replaces the deprecated 'skip' option; signature is (req, key).
        allowList: (req: FastifyRequest, _key: string) => req.url === "/health",
    });

    // ─── Routes ───────────────────────────────────────────────────────────────

    await app.register(async (instance) => {
        await registerRoutes(instance, db, idl, heavyMax, windowMs);
    });

    // ─── Global error handler ─────────────────────────────────────────────────

    app.setErrorHandler((error: FastifyError, _request, reply) => {
        const statusCode = error.statusCode ?? 500;

        logger.error(
            { err: error, statusCode },
            "Request error"
        );

        reply.status(statusCode).send({
            statusCode,
            error: statusCode >= 500 ? "Internal Server Error" : error.name,
            message: statusCode >= 500 ? "An unexpected error occurred" : error.message,
        });
    });

    // ─── GET /health ──────────────────────────────────────────────────────────
    // /health is excluded via allowList above, but kept here so it stays
    // but kept here so it remains co-located with server setup.

    app.get("/health", async (_request, reply) => {
        let dbConnected = false;
        let lastProcessedSignature: string | null = null;

        try {
            await db.query("SELECT 1");
            dbConnected = true;
        } catch {
            dbConnected = false;
        }

        try {
            const { rows } = await db.query<{ last_signature: string | null }>(
                `SELECT last_signature FROM _indexer_state
         ORDER BY updated_at DESC LIMIT 1`
            );
            lastProcessedSignature = rows[0]?.last_signature ?? null;
        } catch {
            // _indexer_state might not be created yet — not critical
        }

        const status = dbConnected ? "ok" : "degraded";

        return reply.status(dbConnected ? 200 : 503).send({
            status,
            uptime: Math.floor(process.uptime()),
            dbConnected,
            lastProcessedSignature,
        });
    });

    return app;
}

// ─── startServer ─────────────────────────────────────────────────────────────

export async function startServer(
    db: DbClient,
    logger: Logger,
    idl: ParsedIdl,
    opts: ServerOptions
): Promise<ReturnType<typeof createServer>> {
    const app = await createServer(db, logger, idl);

    const host = opts.host ?? "0.0.0.0";

    await app.listen({ port: opts.port, host });

    const { max, windowMs } = getRateLimitConfig();
    logger.info(
        { port: opts.port, host, network: opts.network, rateLimitMax: max, rateLimitWindowMs: windowMs },
        "API server started"
    );

    return app;
}

export type ApiServer = ReturnType<typeof createServer>;