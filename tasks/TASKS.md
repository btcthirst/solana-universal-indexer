# Solana Universal Indexer — TASKS.md
> Фази 1–3 із 6. Продовження у TASKS1.md.
> Позначки: [ ] не розпочато · [~] в процесі · [x] виконано

---

## Фаза 1 — Інфраструктура та конфігурація
> Мета: проєкт запускається однією командою, конфігурується через `.env`

### 1.1 Ініціалізація проєкту
- [ ] Створити `package.json` з усіма залежностями:
  - `@coral-xyz/anchor`, `@solana/web3.js` — Solana/Anchor SDK
  - `pg`, `drizzle-orm` — база даних
  - `fastify`, `@fastify/cors` — HTTP API
  - `zod` — валідація конфігурації
  - `pino` — structured logging
  - `typescript`, `tsx`, `@types/*` — dev залежності
- [ ] Налаштувати `tsconfig.json` (target ES2022, moduleResolution bundler, strict mode)
- [ ] Створити `.env.example` з усіма змінними:
  ```
  # --- Мережа ---
  # Варіант 1: Devnet (розробка, безкоштовно, без ліміту)
  SOLANA_RPC_URL=https://api.devnet.solana.com
  SOLANA_WS_URL=wss://api.devnet.solana.com
  SOLANA_NETWORK=devnet

  # Варіант 2: Mainnet через Helius (демо/production)
  # Реєстрація: https://dev.helius.xyz  →  free tier: 100k запитів/день
  # SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
  # SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
  # SOLANA_NETWORK=mainnet-beta

  # --- Програма ---
  PROGRAM_ID=
  IDL_PATH=./idl.json

  # --- База даних ---
  DATABASE_URL=postgresql://user:pass@localhost:5432/indexer

  # --- API ---
  API_PORT=3000
  LOG_LEVEL=info         # debug | info | warn | error

  # --- Режим індексування ---
  MODE=realtime          # realtime | batch
  BATCH_START_SLOT=
  BATCH_END_SLOT=
  BATCH_SIGNATURES=      # comma-separated, опціонально
  ```
- [ ] Додати `src/config/index.ts` — парсинг та валідація env через Zod з чіткими помилками

### 1.2 Docker Compose
- [ ] Створити `docker/Dockerfile` (multi-stage: builder → runner, node:20-alpine)
- [ ] Створити `docker-compose.yml`:
  - сервіс `postgres` (image: postgres:16, healthcheck, volume для persistence)
  - сервіс `indexer` (depends_on postgres з condition healthy, env_file: .env)
- [ ] Створити `docker/init.sql` — початкова системна схема (таблиця `_indexer_state`)
- [ ] Перевірити: `docker compose up` піднімає все без помилок

### 1.3 Структуроване логування
- [ ] Налаштувати `pino` в `src/utils/logger.ts`
- [ ] Формат: JSON у production, pretty-print у development
- [ ] Поля в кожному лозі: `timestamp`, `level`, `service`, `programId`, `msg`
- [ ] Хелпер `withContext(logger, ctx)` для передачі контексту в підмодулі

---

## Фаза 2 — IDL парсер та динамічна схема БД
> Мета: завантажити будь-який Anchor IDL → автоматично створити таблиці в PostgreSQL

### 2.1 IDL завантаження та валідація
- [ ] Створити `src/idl/loader.ts`:
  - Читати IDL з файлу (шлях з конфігу) або з мережі через `anchor.Program.fetchIdl(programId)`
  - Валідувати структуру IDL (наявність `instructions`, `accounts`, `types`)
  - Повертати типізований об'єкт `ParsedIdl`
- [ ] Створити `src/idl/types.ts` — TypeScript-типи для внутрішнього представлення IDL:
  ```typescript
  interface ParsedInstruction { name: string; args: Field[]; accounts: AccountMeta[] }
  interface ParsedAccount    { name: string; fields: Field[] }
  interface Field            { name: string; type: AnchorType }
  ```

### 2.2 Генератор схеми БД
- [ ] Створити `src/db/schema-generator.ts`:
  - Для кожної інструкції з IDL → таблиця `ix_{instruction_name}` зі стовпцями:
    - `id BIGSERIAL PRIMARY KEY`
    - `signature TEXT NOT NULL UNIQUE`
    - `slot BIGINT NOT NULL`
    - `block_time TIMESTAMPTZ`
    - `success BOOLEAN NOT NULL`
    - по одному стовпцю для кожного аргументу інструкції
  - Для кожного акаунта з IDL → таблиця `acc_{account_name}` зі стовпцями:
    - `pubkey TEXT PRIMARY KEY`
    - `slot BIGINT NOT NULL` (останнє оновлення)
    - `lamports BIGINT`
    - по одному стовпцю для кожного поля акаунта
  - Системна таблиця `_indexer_state (key TEXT PRIMARY KEY, value TEXT)`
- [ ] Маппінг типів `AnchorType → SQL`:
  ```
  u8/u16/u32/i8/i16/i32  → INTEGER
  u64/u128/i64/i128       → NUMERIC(40)
  f32/f64                 → DOUBLE PRECISION
  bool                    → BOOLEAN
  publicKey               → TEXT
  string                  → TEXT
  bytes                   → BYTEA
  vec<T>                  → JSONB
  option<T>               → nullable версія T
  struct / enum           → JSONB
  ```
- [ ] Функція `applySchema(db, idl)`:
  - Генерує та виконує `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX` для кожної таблиці
  - Ідемпотентна — безпечно запускати повторно
  - Логує всі створені/вже існуючі таблиці

### 2.3 Підключення до PostgreSQL
- [ ] Створити `src/db/client.ts` — пул підключень через `pg.Pool`
- [ ] Хелпер `query<T>(sql, params)` з типізацією результату
- [ ] Хелпер `transaction(fn)` — автоматичний rollback при помилці
- [ ] Health-check функція `checkDbConnection()`

---

## Фаза 3 — Декодер транзакцій та акаунтів
> Мета: розкодувати будь-яку транзакцію програми через IDL

### 3.1 Декодер інструкцій
- [ ] Створити `src/indexer/decoder.ts`:
  - Ініціалізувати `anchor.BorshInstructionCoder` з IDL
  - Функція `decodeInstruction(ix: TransactionInstruction): DecodedInstruction | null`
    - Повертає `null` якщо інструкція не належить нашій програмі
    - Повертає `{ name, args: Record<string, unknown> }` при успіху
  - Обробляти помилки декодування (corrupted data) без краша
- [ ] Функція `extractInstructions(tx: ParsedTransactionWithMeta): DecodedInstruction[]`
  - Фільтрує інструкції за `programId`
  - Враховує **inner instructions** (CPI виклики всередині транзакції)

### 3.2 Декодер акаунтів
- [ ] Розширити `src/indexer/decoder.ts`:
  - Ініціалізувати `anchor.BorshAccountsCoder` з IDL
  - Функція `decodeAccount(accountName: string, data: Buffer): Record<string, unknown> | null`
  - Функція `identifyAccountType(data: Buffer, idl): string | null`
    - Перевіряє discriminator (перші 8 байт) для кожного типу акаунта з IDL

### 3.3 Збереження декодованих даних
- [ ] Створити `src/db/writer.ts`:
  - `writeInstruction(db, tableName, data)` — INSERT з `ON CONFLICT (signature) DO NOTHING`
  - `writeAccount(db, tableName, pubkey, data)` — UPSERT по `pubkey`
  - `writeBatch(db, instructions[], accounts[])` — все в одній транзакції
- [ ] Серіалізація BigInt → string перед записом у pg
- [ ] Серіалізація PublicKey → base58 string