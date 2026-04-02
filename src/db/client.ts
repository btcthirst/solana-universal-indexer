import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { Logger } from "pino";
import { loadConfig } from "../config";

type Config = ReturnType<typeof loadConfig>;

export function createDbClient(config: Config, logger: Logger) {
    const pool = new Pool({
        connectionString: config.databaseUrl,
        // sensible defaults — tune per env if needed
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    });

    // surface unexpected pool-level errors instead of crashing silently
    pool.on("error", (err) => {
        logger.error({ err }, "Unexpected PostgreSQL pool error");
    });

    // ---------------------------------------------------------------------------
    // query<T> — single-shot query, auto-releases connection back to pool
    // ---------------------------------------------------------------------------
    async function query<T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params?: unknown[]
    ): Promise<QueryResult<T>> {
        const start = Date.now();
        try {
            const result = await pool.query<T>(sql, params);
            logger.debug(
                { sql, durationMs: Date.now() - start, rows: result.rowCount },
                "query ok"
            );
            return result;
        } catch (err) {
            logger.error({ err, sql }, "query failed");
            throw err;
        }
    }

    // ---------------------------------------------------------------------------
    // transaction — wraps a callback in BEGIN / COMMIT / ROLLBACK
    // ---------------------------------------------------------------------------
    async function transaction<T>(
        fn: (client: PoolClient) => Promise<T>
    ): Promise<T> {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (err) {
            await client.query("ROLLBACK");
            logger.error({ err }, "transaction rolled back");
            throw err;
        } finally {
            client.release();
        }
    }

    // ---------------------------------------------------------------------------
    // checkDbConnection — used at startup (Definition of Done: SELECT 1)
    // ---------------------------------------------------------------------------
    async function checkDbConnection(): Promise<void> {
        try {
            await query("SELECT 1");
            logger.info("Database connection OK");
        } catch (err) {
            logger.error({ err }, "Database connection FAILED");
            throw err;
        }
    }

    return { pool, query, transaction, checkDbConnection };
}

// Convenience type so callers can annotate without importing Pool directly
export type DbClient = ReturnType<typeof createDbClient>;