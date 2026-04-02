import type { Logger } from "pino";
import type { Pool } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

type CleanupFn = () => Promise<void> | void;

// ─── State ────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
const cleanupHandlers: CleanupFn[] = [];

export function getIsShuttingDown(): boolean {
    return isShuttingDown;
}

// ─── Register cleanup handlers ────────────────────────────────────────────────
// Called in the order of registration during shutdown

export function onShutdown(fn: CleanupFn): void {
    cleanupHandlers.push(fn);
}

// ─── setupShutdown ────────────────────────────────────────────────────────────

export function setupShutdown(logger: Logger): void {
    const log = logger.child({ module: "shutdown" });

    async function shutdown(signal: string, exitCode = 0): Promise<void> {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.info({ signal }, "Shutdown initiated — waiting for current batch to complete...");

        // Force-exit timeout — if cleanup hangs for more than 10 seconds
        const forceExit = setTimeout(() => {
            log.error("Shutdown timed out after 10s — force exiting");
            process.exit(1);
        }, 10_000);

        // Do not let the timeout block process.exit
        forceExit.unref();

        try {
            // Call all cleanup handlers sequentially
            for (const fn of cleanupHandlers) {
                try {
                    await fn();
                } catch (err) {
                    log.error({ err }, "Error during cleanup handler");
                }
            }

            log.info("Graceful shutdown complete");
            clearTimeout(forceExit);
            process.exit(exitCode);
        } catch (err) {
            log.error({ err }, "Unexpected error during shutdown");
            clearTimeout(forceExit);
            process.exit(1);
        }
    }

    // SIGINT — Ctrl+C
    process.on("SIGINT", () => shutdown("SIGINT", 0));

    // SIGTERM — docker stop, k8s, systemd
    process.on("SIGTERM", () => shutdown("SIGTERM", 0));

    // SIGUSR2 — nodemon restart
    process.on("SIGUSR2", () => shutdown("SIGUSR2", 0));

    // Uncaught exceptions — log and exit with code 1
    process.on("uncaughtException", (err) => {
        log.error({ err }, "Uncaught exception");
        shutdown("uncaughtException", 1);
    });

    process.on("unhandledRejection", (reason) => {
        log.error({ reason }, "Unhandled promise rejection");
        shutdown("unhandledRejection", 1);
    });

    log.info("Shutdown handlers registered (SIGINT, SIGTERM, SIGUSR2)");
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

export function registerDbShutdown(pool: Pool, logger: Logger): void {
    onShutdown(async () => {
        logger.info("Closing database pool...");
        await pool.end();
        logger.info("Database pool closed");
    });
}

export function registerWsShutdown(
    stopFn: () => void,
    logger: Logger
): void {
    onShutdown(() => {
        logger.info("Closing WebSocket subscription...");
        stopFn();
        logger.info("WebSocket subscription closed");
    });
}