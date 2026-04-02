import Fastify, { FastifyError } from "fastify";
import cors from "@fastify/cors";
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

// ─── createServer ─────────────────────────────────────────────────────────────

export async function createServer(db: DbClient, logger: Logger, idl: ParsedIdl) {
    const app = Fastify({
        loggerInstance: logger,
        disableRequestLogging: false,
    });

    // ─── CORS ────────────────────────────────────────────────────────────────────

    app.register(cors, {
        origin: true,   // replace with specific domains in prod
    });

    await app.register(async (instance) => {
        await registerRoutes(instance, db, idl);
    })

    // ─── Global error handler ─────────────────────────────────────────────────────

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

    // ─── GET /health ──────────────────────────────────────────────────────────────

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

    logger.info(
        { port: opts.port, host, network: opts.network },
        "API server started"
    );

    return app;
}

export type ApiServer = ReturnType<typeof createServer>;