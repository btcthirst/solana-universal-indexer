# solana-universal-indexer

A universal, IDL-driven indexer for any Anchor-based Solana program. Point it at an IDL, and it automatically generates a PostgreSQL schema, decodes transactions, and exposes a REST API — no custom code required.

---

## Architectural Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Data Sources                         │
│                                                             │
│   WebSocket (realtime)        Batch fetcher (slot range)    │
│          └──────────┬─────────────┘                         │
│                     ▼                                       │
│             Solana RPC Client                               │
│          (retry + backoff + 429)                            │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Indexer Core                          │
│                                                             │
│   IDL Loader → BorshInstructionCoder → Decoder             │
│       │              │                    │                 │
│       │         BorshAccountsCoder        │                 │
│       ▼                                   ▼                 │
│  Schema Generator                       Writer              │
│  (CREATE TABLE IF NOT EXISTS)    (INSERT / UPSERT)          │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────────────────────────────────────────── ┐
│                        PostgreSQL                           │
│                                                             │
│   ix_<instruction>   acc_<account>   _indexer_state         │
└──────────────────────────────────────┬──────────────────────┘
                                       │
                                       ▼
                              ┌────────────────┐
                              │  Fastify API   │
                              │  /instructions │
                              │  /accounts     │
                              │  /stats        │
                              │  /health       │
                              └───────┬────────┘
                                      │
                                      ▼
                                   Client
```

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/yourname/solana-universal-indexer
cd solana-universal-indexer
cp .env.example .env   # fill in your values

# 2. Start PostgreSQL and run the indexer
make db-up dev

# 3. Query the API
curl http://localhost:3000/health
```

---

## Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROGRAM_ID` | ✅ | — | Solana program address to index |
| `MODE` | ✅ | — | `realtime` or `batch` |
| `SOLANA_NETWORK` | ✅ | — | `devnet` or `mainnet-beta` |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `SOLANA_RPC_URL` | — | Public endpoint | RPC URL (use Helius for mainnet) |
| `SOLANA_WS_URL` | — | — | WebSocket URL (required for mainnet realtime) |
| `IDL_PATH` | — | `./idl.json` | Path to Anchor IDL file |
| `API_PORT` | — | `3000` | Fastify HTTP port |
| `LOG_LEVEL` | — | `info` | Pino log level |
| `BATCH_START_SLOT` | — | — | Start slot for batch mode |
| `BATCH_END_SLOT` | — | — | End slot for batch mode |
| `BATCH_SIGNATURES` | — | — | Comma-separated list of signatures |
| `POSTGRES_USER` | — | `postgres` | PostgreSQL user (for Docker) |
| `POSTGRES_PASSWORD` | — | `postgres` | PostgreSQL password (for Docker) |
| `POSTGRES_DB` | — | `indexer` | PostgreSQL database name |

### `.env.example`

```env
PROGRAM_ID=4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy
MODE=realtime
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/indexer
IDL_PATH=./idl.json
API_PORT=3000
LOG_LEVEL=info

POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=indexer
```

---

## API Examples

### Health check

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "uptime": 142,
  "dbConnected": true,
  "lastProcessedSignature": "5KtP..."
}
```

### List available endpoints

```bash
curl http://localhost:3000/
```

### Instructions

```bash
# List make_offer calls with filters
curl "http://localhost:3000/instructions/make_offer?limit=10&success=true"

# Filter by slot range
curl "http://localhost:3000/instructions/make_offer?slot_from=300000000&slot_to=310000000"

# Single call by signature
curl "http://localhost:3000/instructions/make_offer/5KtPmn..."
```

```json
{
  "data": [
    {
      "id": 1,
      "signature": "5KtP...",
      "slot": 305123456,
      "block_time": "2024-11-20T10:00:00Z",
      "success": true,
      "caller": "7xK2...",
      "arg_id": "1",
      "arg_token_a_offered_amount": "1000000",
      "arg_token_b_wanted_amount": "2000000"
    }
  ],
  "total": 16,
  "limit": 10,
  "offset": 0
}
```

### Accounts

```bash
# List Offer accounts
curl "http://localhost:3000/accounts/Offer?limit=5"

# Single account by pubkey
curl "http://localhost:3000/accounts/Offer/AbC123..."
```

### Statistics

```bash
# Aggregated stats per instruction
curl http://localhost:3000/stats/instructions
```

```json
{
  "make_offer": { "total": 16, "success": 14, "failed": 2, "last_called": "2024-11-20T10:00:00Z" },
  "take_offer": { "total": 12, "success": 12, "failed": 0, "last_called": "2024-11-20T09:55:00Z" }
}
```

```bash
# Timeseries — calls per day
curl "http://localhost:3000/stats/instructions/make_offer/timeseries?interval=day"

# Timeseries — calls per hour for a date range
curl "http://localhost:3000/stats/instructions/make_offer/timeseries?from=2024-11-01&to=2024-11-30&interval=hour"

# Top callers
curl "http://localhost:3000/stats/instructions/make_offer/top-callers?limit=5"

# Overall program stats
curl http://localhost:3000/stats/program
```

```json
{
  "programId": "4g5EN9Sk7wEcZqfjdjDtvq7T9u5YUrBKTe23fVJoL8yy",
  "name": "escrow",
  "totalTransactions": 28,
  "uniqueAccounts": 3,
  "firstSeen": "2024-11-15T08:00:00Z",
  "lastSeen": "2024-11-20T10:00:00Z",
  "indexedInstructions": ["make_offer", "take_offer"],
  "indexedAccountTypes": ["Offer"]
}
```

---

## Makefile Commands

```bash
make db-up        # start PostgreSQL container
make dev          # run indexer locally (tsx watch)
make build        # compile TypeScript → dist/
make test         # run all tests
make db-shell     # open psql in the container
make db-reset     # drop volume + restart (fresh DB)
make docker-up    # full stack (postgres + indexer)
make env-check    # validate .env has required keys
```

---

## Key Decisions

### Why TypeScript, not Rust?

The indexer spends most of its time waiting on I/O — RPC calls, database writes, WebSocket events. TypeScript's async/await model handles this well with minimal overhead. Rust would give better CPU throughput but add significant complexity to the decoder and schema generation code, which benefits from dynamic reflection over the IDL. The tradeoff: easier development and iteration speed over raw performance.

### Why Fastify, not Express?

Fastify is measurably faster than Express due to its schema-based serialization and compiled route matching. It also has first-class TypeScript support, a built-in pino logger, and a plugin architecture that made CORS and error handling straightforward. Express has a larger ecosystem, but for a purpose-built indexer API, Fastify's performance and type safety are worth more.

### Why JSONB for complex types, not separate tables?

Anchor IDLs can contain deeply nested structs, enums, and vectors. Normalizing every nested type into its own table would require recursive schema generation and complex JOIN queries at read time. JSONB gives us: schema simplicity (one column per field regardless of nesting), full PostgreSQL indexing support (`@>`, `?`, GIN indexes), and flexibility when the IDL changes. The tradeoff: you lose typed columns for nested fields and can't do simple `WHERE field = value` queries on them without JSON operators.

### How cold start is handled

On startup in realtime mode, the indexer reads `last_processed_signature` from `_indexer_state`. If it exists, it fetches all signatures newer than that cursor (paginated, 1000 at a time) and processes them as a batch before switching to WebSocket subscription. This guarantees no gaps between the previous run and the current one. The cursor is saved every 10 transactions so a crash mid-backfill loses at most 10 transactions.

### Current limitations and what could be improved

**Account indexing** — accounts are not decoded inline during transaction processing because `getParsedTransaction` doesn't return raw account data. A separate `getProgramAccounts` sweep is needed to snapshot account state. This could be automated post-batch.

**Top callers** — currently returns callers by the `caller` column (first account in the instruction). For programs where the signer is not always `accounts[0]`, this would require IDL-aware mapping per instruction.

**No re-indexing** — if the schema changes (e.g. new fields in the IDL), existing tables are not migrated. `CREATE TABLE IF NOT EXISTS` is idempotent but won't add new columns. A migration system (e.g. Flyway or custom `ALTER TABLE`) would be needed for production.

**Public RPC rate limits** — the public devnet endpoint rate-limits aggressively at `TX_BATCH_SIZE > 3`. For production, use a dedicated RPC provider (Helius, QuickNode, Triton) and increase batch size to 10–20.

**Single program** — each indexer instance handles one program. Running multiple programs requires multiple instances, each with their own `.env`. A multi-program mode would require namespacing tables by `program_id`.