import { loadConfig } from "../src/config";
import { createLogger } from "../src/utils/logger";
import { createDbClient } from "../src/db/client";
import { loadIdl } from "../src/idl/loader";
import { applySchema } from "../src/db/schema-generator";
import { createConnection, createRpcClient } from "../src/utils/rpc";
import { createDecoder } from "../src/indexer/decoder";
import { runBatch } from "../src/indexer/batch";
import { PublicKey } from "@solana/web3.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const config = loadConfig();
const logger = createLogger(config);
const db = createDbClient(config, logger);
const connection = createConnection(config, logger);
const rpc = createRpcClient(connection, logger);

async function seed() {
    logger.info("Seeding started...");

    await db.checkDbConnection();

    const idl = await loadIdl({ filePath: config.idlPath }, logger);
    await applySchema(db, idl, logger);
    const decoder = createDecoder(idl, logger);
    const programId = new PublicKey(idl.address);

    // Fetch the latest 100 signatures for devnet
    const limit = config.solanaNetwork === "mainnet-beta" ? 500 : 100;

    const sigs = await rpc.getSignaturesForAddress(programId, { limit });
    logger.info({ count: sigs.length }, `Fetched ${sigs.length} signatures`);

    await runBatch(
        {
            programId,
            signatures: sigs.map(s => s.signature),
        },
        rpc, decoder, idl, db, logger
    );

    // Save demo output to a file
    const { rows } = await db.query(
        `SELECT * FROM ix_${idl.instructions[0]?.name.replace(/([A-Z])/g, "_$1").toLowerCase()} LIMIT 20`
    );

    await mkdir(join(process.cwd(), "demo"), { recursive: true });
    await writeFile(
        join(process.cwd(), "demo", "mainnet-demo.json"),
        JSON.stringify({ program: idl.name, network: config.solanaNetwork, sample: rows }, null, 2)
    );

    logger.info("Seed complete — demo saved to demo/mainnet-demo.json");
    await db.pool.end();
}

seed().catch(err => {
    console.error(err);
    process.exit(1);
});