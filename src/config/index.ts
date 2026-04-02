import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
    // Required field with custom error message
    PROGRAM_ID: z.string().min(1, "Config validation failed: PROGRAM_ID is required"),

    // New Zod 4 syntax for enums
    MODE: z.enum(["realtime", "batch"], {}),

    SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"], {}),

    // Parse string from env to number + default value
    API_PORT: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.coerce.number().default(3000)
    ),

    // Optional parameters and default values
    SOLANA_RPC_URL: z.string().optional(),
    SOLANA_WS_URL: z.string().optional(),
    IDL_PATH: z.string().default("./idl.json"),
    DATABASE_URL: z.string().optional(),
    LOG_LEVEL: z.string().default("info"),

    // Batch processing parameters
    BATCH_START_SLOT: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.coerce.number().optional()
    ),
    BATCH_END_SLOT: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.coerce.number().optional()
    ),
    BATCH_SIGNATURES: z.string().optional().transform(v => v === "" ? undefined : v),
});

export function loadConfig() {
    // safeParse returns { success: true, data: ... } or { success: false, error: ... }
    const result = configSchema.safeParse(process.env);

    if (!result.success) {
        // Get the message from the first encountered error
        const firstErrorMessage = result.error.issues[0]?.message;
        throw new Error(firstErrorMessage || "Config validation failed");
    }

    const { data } = result;

    // Return a flat object for easy access in the application
    return {
        solanaRpcUrl: data.SOLANA_RPC_URL,
        solanaWsUrl: data.SOLANA_WS_URL,
        solanaNetwork: data.SOLANA_NETWORK,
        programId: data.PROGRAM_ID,
        idlPath: data.IDL_PATH,
        databaseUrl: data.DATABASE_URL,
        apiPort: data.API_PORT,
        logLevel: data.LOG_LEVEL,
        mode: data.MODE,
        batchStartSlot: data.BATCH_START_SLOT,
        batchEndSlot: data.BATCH_END_SLOT,
        batchSignatures: data.BATCH_SIGNATURES,
    };
}