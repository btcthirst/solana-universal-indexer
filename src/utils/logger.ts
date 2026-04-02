import pino from "pino";
import type { Logger } from "pino";
import { loadConfig } from "../config";

type Config = ReturnType<typeof loadConfig>;

function createLogger(config: Config): Logger {
    const isDev = process.env.NODE_ENV !== "production";

    return pino(
        {
            level: config.logLevel,
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
            base: {
                service: "solana-indexer",
                programId: config.programId,
                network: config.solanaNetwork,
                mode: config.mode,
            },
        },
        isDev
            ? pino.transport({
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname",
                },
            })
            : undefined
    );
}

export function withContext(
    baseLogger: Logger,
    ctx: Record<string, unknown>
): Logger {
    return baseLogger.child(ctx);
}

export { createLogger };