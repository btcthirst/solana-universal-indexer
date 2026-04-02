import { loadConfig } from "./config";
import { createLogger } from "./utils/logger";
import { createDbClient } from "./db/client";
import { loadIdl } from "./idl/loader";
import { applySchema } from "./db/schema-generator";
import { createConnection, createRpcClient } from "./utils/rpc";
import { createDecoder } from "./indexer/decoder";
import { runBatch } from "./indexer/batch";
import { runRealtime } from "./indexer/realtime";
import { setupShutdown, registerDbShutdown, onShutdown } from "./utils/shutdown";
import { PublicKey } from "@solana/web3.js";
import { startServer } from "./api/server";

const config = loadConfig();
const logger = createLogger(config);

setupShutdown(logger);

const db = createDbClient(config, logger);
registerDbShutdown(db.pool, logger);

const connection = createConnection(config, logger);
const rpc = createRpcClient(connection, logger);

async function main() {
    logger.info(`Indexer starting on ${config.solanaNetwork}...`);

    await db.checkDbConnection();

    const idl = await loadIdl({ filePath: config.idlPath }, logger);
    logger.info({ instructions: idl.instructions.map(i => i.name) }, "IDL ready");

    await applySchema(db, idl, logger);

    // run in parallel with the indexer
    const apiServer = await startServer(db, logger, idl, {
        port: config.apiPort,
        programId: idl.address,
        network: config.solanaNetwork,
    });

    onShutdown(async () => {
        await apiServer.close();
        logger.info("API server closed");
    });

    const decoder = createDecoder(idl, logger);
    const programId = new PublicKey(idl.address);

    if (config.mode === "batch") {
        const signatures = config.batchSignatures
            ?.split(",")
            .map(s => s.trim())
            .filter(Boolean);

        await runBatch(
            {
                programId,
                startSlot: config.batchStartSlot,
                endSlot: config.batchEndSlot,
                signatures,
            },
            rpc, decoder, idl, db, logger
        );
    } else {
        // realtime — blocking call, shutdown is registered inside runRealtime
        await runRealtime(
            {
                programId,
                network: config.solanaNetwork,
                connection,
            },
            rpc, decoder, idl, db, logger
        );
    }
}

main().catch((err) => {
    logger.error({ err }, "Fatal error");
    process.exit(1);
});