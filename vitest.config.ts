import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],

        coverage: {
            provider: "v8",

            // text        → terminal table on every run
            // lcov        → Codecov / GitHub Actions upload
            // html        → browsable report at coverage/index.html
            // json-summary → badge generators and CI scripts
            reporter: ["text", "lcov", "html", "json-summary"],

            include: ["src/**/*.ts"],
            exclude: [
                // Entry point — orchestration only, no logic.
                "src/index.ts",
                // Type-only file — zero runtime statements.
                "src/idl/types.ts",
                // Require live external dependencies (pg, Solana RPC, WebSocket):
                "src/db/client.ts",
                "src/db/writer.ts",
                "src/idl/loader.ts",
                "src/indexer/batch.ts",
                "src/indexer/realtime.ts",
                "src/utils/logger.ts",
                "src/utils/shutdown.ts",
                "src/config/index.ts",
            ],

            thresholds: {
                // Global safety net for any new file added without tests.
                // Must sit at or below the weakest measured file's actual numbers
                // so per-file overrides (below) do the real enforcement without
                // fighting the global check.
                // Weakest actuals: branches=42.85 (server.ts), functions=22.22 (rpc.ts).
                lines: 60,
                functions: 20,
                branches: 40,
                statements: 55,

                // perFile enforces each file against its own threshold entry.
                perFile: true,

                // Per-file thresholds set at (actual measured − 2%).

                "src/db/schema-generator.ts": {
                    lines: 68,
                    functions: 64,
                    branches: 76,
                    statements: 68,
                },

                "src/indexer/decoder.ts": {
                    lines: 80,
                    functions: 85,
                    branches: 70,
                    statements: 80,
                },

                "src/indexer/account-sweeper.ts": {
                    lines: 93,
                    functions: 98,
                    branches: 85,
                    statements: 92,
                },

                "src/utils/rpc.ts": {
                    lines: 60,
                    functions: 20,
                    branches: 65,
                    statements: 56,
                },

                "src/api/routes.ts": {
                    lines: 98,
                    functions: 98,
                    branches: 82,
                    statements: 98,
                },

                "src/api/server.ts": {
                    lines: 67,
                    functions: 58,
                    branches: 40,
                    statements: 67,
                },
            },
        },
    },
});