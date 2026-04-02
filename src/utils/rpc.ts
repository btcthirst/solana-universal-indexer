import {
    Connection,
    PublicKey,
    GetVersionedTransactionConfig,
    SignaturesForAddressOptions,
    GetProgramAccountsConfig,
} from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import type { Logger } from "pino";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RetryOptions {
    maxAttempts?: number;   // default 5
    baseDelay?: number;     // default 500ms
    maxDelay?: number;      // default 8000ms
    jitter?: number;        // default 0.2 (±20%)
}

type LoadConfig = {
    solanaNetwork: string;
    solanaRpcUrl?: string;
    solanaWsUrl?: string;
};

// ─── withRetry ────────────────────────────────────────────────────────────────

export async function withRetry<T>(
    fn: () => Promise<T>,
    logger: Logger,
    opts: RetryOptions = {}
): Promise<T> {
    const {
        maxAttempts = 5,
        baseDelay = 500,
        maxDelay = 8_000,
        jitter = 0.2,
    } = opts;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // 429 — parse Retry-After header if present
            const retryAfterMs = parseRetryAfter(err);
            if (retryAfterMs !== null) {
                logger.warn(
                    { attempt, retryAfterMs },
                    "Rate limited (429) — waiting Retry-After"
                );
                await sleep(retryAfterMs);
                continue;
            }

            if (attempt === maxAttempts) break;

            // Exponential backoff: min(base * 2^(attempt-1), maxDelay)
            const expDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

            // Jitter ±20%
            const jitterFactor = 1 + jitter * (Math.random() * 2 - 1);
            const delay = Math.round(expDelay * jitterFactor);

            logger.warn(
                { attempt, maxAttempts, delayMs: delay, err },
                "RPC request failed — retrying"
            );

            await sleep(delay);
        }
    }

    throw lastError;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(err: unknown): number | null {
    if (typeof err !== "object" || err === null) return null;

    const e = err as Record<string, unknown>;

    // Helius and most RPC providers throw an error with a status or statusCode field
    const status = (e["status"] ?? e["statusCode"]) as number | undefined;
    if (status !== 429) return null;

    // Try to get Retry-After from headers
    const headers = e["headers"] as Record<string, string> | undefined;
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
    if (retryAfter) {
        const seconds = parseFloat(retryAfter);
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }

    // Fallback — wait 10s if the header is missing
    return 10_000;
}

// ─── createConnection ─────────────────────────────────────────────────────────

export function createConnection(config: LoadConfig, logger: Logger): Connection {
    const rpcUrl = config.solanaRpcUrl ?? defaultRpcUrl(config.solanaNetwork);

    let connection: Connection;

    if (config.solanaNetwork === "mainnet-beta" && config.solanaWsUrl) {
        connection = new Connection(rpcUrl, {
            commitment: "confirmed",
            wsEndpoint: config.solanaWsUrl,
        });
        logger.info({ network: config.solanaNetwork, rpcUrl }, "Connected to mainnet via Helius");
    } else {
        connection = new Connection(rpcUrl, "confirmed");
        logger.info({ network: config.solanaNetwork, rpcUrl }, "Connected to devnet");
    }

    return connection;
}

function defaultRpcUrl(network: string): string {
    return network === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";
}

// ─── RPC client with retry ──────────────────────────────────────────────────────

export function createRpcClient(
    connection: Connection,
    logger: Logger,
    retryOpts?: RetryOptions
) {
    const log = logger.child({ module: "rpc" });

    function retry<T>(fn: () => Promise<T>): Promise<T> {
        return withRetry(fn, log, retryOpts);
    }

    // ─── getTransaction ────────────────────────────────────────────────────────

    function getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
        const opts: GetVersionedTransactionConfig = {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
        };
        return retry(() => connection.getParsedTransaction(signature, opts));
    }

    // ─── getSignaturesForAddress ───────────────────────────────────────────────

    function getSignaturesForAddress(
        pubkey: PublicKey,
        opts?: SignaturesForAddressOptions
    ) {
        return retry(() => connection.getSignaturesForAddress(pubkey, opts));
    }

    // ─── getProgramAccounts ────────────────────────────────────────────────────

    function getProgramAccounts(
        programId: PublicKey,
        opts?: GetProgramAccountsConfig
    ) {
        return retry(() => connection.getProgramAccounts(programId, opts));
    }

    // ─── getSlot ───────────────────────────────────────────────────────────────

    function getSlot() {
        return retry(() => connection.getSlot("confirmed"));
    }

    // ─── getBlockTime ──────────────────────────────────────────────────────────

    function getBlockTime(slot: number) {
        return retry(() => connection.getBlockTime(slot));
    }

    return {
        connection,
        getTransaction,
        getSignaturesForAddress,
        getProgramAccounts,
        getSlot,
        getBlockTime,
    };
}

export type RpcClient = ReturnType<typeof createRpcClient>;