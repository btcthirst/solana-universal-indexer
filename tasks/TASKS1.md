# Solana Universal Indexer — TASKS1.md
> Фази 4–6 із 6. Початок у TASKS.md.
> Позначки: [ ] не розпочато · [~] в процесі · [x] виконано

---

## Фаза 4 — Режими індексування
> Мета: batch mode + realtime mode з cold start

### 4.1 Спільна логіка — RPC клієнт з reliability
- [ ] Створити `src/utils/rpc.ts` — обгортка над `@solana/web3.js Connection`:
  - **Exponential backoff**: затримка `min(base * 2^attempt, maxDelay)` між спробами
    ```
    attempt 1 → 500ms, attempt 2 → 1s, attempt 3 → 2s, attempt 4 → 4s, attempt 5 → 8s (max)
    ```
  - **Retry**: до 5 спроб для кожного запиту, логування кожної невдалої спроби
  - **Jitter**: додати ±20% випадковості до затримки щоб уникнути thundering herd
  - **429 Rate Limit handling**: при отриманні HTTP 429 від Helius — парсити заголовок
    `Retry-After` і чекати вказаний час перед наступною спробою
  - Типізована функція `withRetry<T>(fn: () => Promise<T>, opts?): Promise<T>`
- [ ] Обгортки з retry для:
  - `getTransaction(signature, { maxSupportedTransactionVersion: 0 })`
  - `getSignaturesForAddress(pubkey, { before, until, limit })`
  - `getProgramAccounts(programId, { filters })`
  - `getSlot()`, `getBlockTime(slot)`
- [ ] Функція `createConnection(config)`:
  - Devnet: `new Connection(rpcUrl, "confirmed")`
  - Mainnet/Helius: `new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl })`
  - Логувати при старті яку мережу використовуємо (`config.network`)

### 4.2 Batch Mode
- [ ] Створити `src/indexer/batch.ts`:
  - **За slot range** (`BATCH_START_SLOT` → `BATCH_END_SLOT`):
    - Отримати всі signatures програми в діапазоні через `getSignaturesForAddress`
    - Пагінація: ітерувати по 1000 signatures за раз (ліміт RPC)
    - Зупинятись коли signature.slot < startSlot
  - **За списком signatures** (`BATCH_SIGNATURES`):
    - Розбити рядок на масив, дедублювати
  - **Обробка**: паралельно обробляти транзакції батчами по 10 (`Promise.allSettled`)
  - **Прогрес**: логувати кожні 100 оброблених транзакцій (оброблено / всього / %)
  - **Помилки**: пропускати транзакції що не вдалось декодувати (лог + continue)

### 4.3 Realtime Mode з Cold Start
- [ ] Створити `src/indexer/realtime.ts`:
  - **Cold start** (backfill):
    1. Прочитати `last_processed_signature` з таблиці `_indexer_state`
    2. Якщо є — завантажити всі пропущені транзакції (від останньої до поточної)
    3. Використати той самий пагінований механізм що і в batch mode
    4. Після backfill — зберегти нову `last_processed_signature`
  - **Перехід в realtime**:
    - Підписатись через WebSocket: `connection.onLogs(programId, callback)`
    - При отриманні нового логу — завантажити повну транзакцію та обробити
    - При розриві WebSocket — автоматичне перепідключення з backoff
  - **State persistence**: зберігати `last_processed_signature` після кожні 10 транзакцій

### 4.4 Graceful Shutdown
- [ ] Створити `src/utils/shutdown.ts`:
  - Перехопити `SIGINT`, `SIGTERM`, `SIGUSR2` (nodemon)
  - Встановити прапор `isShuttingDown = true`
  - Дочекатись завершення поточного батча (не переривати на середині)
  - Закрити WebSocket підписку
  - Закрити пул БД (`pool.end()`)
  - Вийти з кодом 0 (або 1 при помилці)
  - Таймаут force-exit через 10 секунд якщо щось зависло

### 4.5 Точка входу
- [ ] Створити `src/index.ts`:
  - Завантажити конфіг → підключитись до БД → завантажити IDL → згенерувати схему
  - Залежно від `MODE`: запустити `batchIndexer` або `realtimeIndexer`
  - Запустити HTTP API сервер паралельно (для healthcheck та queries)
  - Зареєструвати graceful shutdown handlers

---

## Фаза 5 — Advanced API
> Мета: REST API з фільтрацією, агрегацією, статистикою

### 5.1 Базова структура Fastify
- [ ] Створити `src/api/server.ts`:
  - Ініціалізувати Fastify з `pino` логером
  - Підключити `@fastify/cors`
  - Глобальний error handler — повертати `{ error, message, statusCode }`
  - Healthcheck: `GET /health` → `{ status: "ok", uptime, dbConnected, lastProcessedSignature }`

### 5.2 Ендпоінти для інструкцій
- [ ] `GET /instructions/:name` — список викликів інструкції з фільтрацією:
  - Query params: `?slot_from=&slot_to=&success=true&limit=50&offset=0`
  - Динамічно будувати SQL WHERE на основі присутніх params
  - Відповідь: `{ data: [...], total: number, limit, offset }`
- [ ] `GET /instructions/:name/:signature` — деталі одного виклику за signature

### 5.3 Ендпоінти для акаунтів
- [ ] `GET /accounts/:type` — список акаунтів певного типу:
  - Query params: `?pubkey=&limit=50&offset=0`
- [ ] `GET /accounts/:type/:pubkey` — стан конкретного акаунта

### 5.4 Агрегація та статистика
- [ ] `GET /stats/instructions` — зведена статистика по інструкціях:
  ```json
  {
    "initialize": { "total": 1500, "success": 1490, "failed": 10, "last_called": "..." },
    "deposit":    { "total": 8200, "success": 8195, "failed": 5,  "last_called": "..." }
  }
  ```
- [ ] `GET /stats/instructions/:name/timeseries` — кількість викликів по часу:
  - Query params: `?from=2024-01-01&to=2024-12-31&interval=day` (day/hour/week)
  - SQL: `DATE_TRUNC(interval, block_time)` + `GROUP BY`
  - Відповідь: `[{ period: "2024-01-01", count: 42, success: 40 }, ...]`
- [ ] `GET /stats/program` — загальна статистика програми:
  ```json
  {
    "programId": "...",
    "totalTransactions": 50000,
    "uniqueAccounts": 3200,
    "firstSeen": "2024-01-15T...",
    "lastSeen": "2024-11-20T...",
    "indexedInstructions": ["initialize", "deposit", "withdraw"],
    "indexedAccountTypes": ["UserAccount", "VaultAccount"]
  }
  ```
- [ ] `GET /stats/instructions/:name/top-callers` — топ адрес за кількістю викликів:
  - Query params: `?limit=10`

### 5.5 Валідація та документація
- [ ] Валідація query params через Zod (або Fastify JSON Schema) для всіх ендпоінтів
- [ ] Повертати 400 з описовою помилкою при неправильних params
- [ ] Додати `GET /` → повертати список доступних ендпоінтів (self-documenting API)

---

## Фаза 6 — Якість, тести, README
> Мета: код готовий до оцінки суддями

### 6.1 Тести
- [ ] Налаштувати `vitest` або `jest` + `ts-jest`
- [ ] Unit тести для `schema-generator.ts`:
  - Перевірити маппінг кожного Anchor типу → SQL тип
  - Перевірити генерацію назв таблиць
- [ ] Unit тести для `decoder.ts`:
  - Мок IDL + мок transaction → перевірити правильність декодування
  - Перевірити що `null` повертається для чужих інструкцій
- [ ] Unit тести для `rpc.ts` (withRetry):
  - Перевірити що робить N спроб перед throw
  - Перевірити exponential backoff затримки (mock `setTimeout`)
- [ ] Integration тест для API:
  - Піднімати тестову БД (або `pg-mem`)
  - Перевірити `/health`, `/stats/program`, `/instructions/:name`
- [ ] Скрипт `npm test` запускає всі тести

### 6.2 Скрипти та DX
- [ ] `npm run dev` — запуск через `tsx watch src/index.ts`
- [ ] `npm run build` — компіляція в `dist/`
- [ ] `npm run start` — запуск скомпільованого `dist/index.js`
- [ ] `npm run lint` — ESLint з правилами для TypeScript
- [ ] `npm run typecheck` — `tsc --noEmit`
- [ ] `scripts/seed-test-idl.ts` — завантажити тестовий IDL і проіндексувати транзакції для демо:
  - **Devnet**: використати будь-який тестовий IDL, проіндексувати 100 транзакцій
  - **Mainnet demo** (для README): підключитись через Helius free tier до Marinade Finance
    (`MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`) і проіндексувати 500 транзакцій
  - Зберегти результат скріншоту або curl-виводу як `demo/mainnet-demo.json`

### 6.3 README.md
- [ ] **Architectural Overview** — схема компонентів (ASCII або Mermaid):
  ```
  IDL → Schema Generator → PostgreSQL
                              ↑
  Solana RPC → Decoder → Writer
       ↑
  WebSocket (realtime) / Batch fetcher
                              ↓
                         Fastify API → Client
  ```
- [ ] **Setup** — кроки від нуля до запуску (3 команди максимум)
- [ ] **Configuration** — таблиця всіх env змінних з описом та дефолтами
- [ ] **API Examples** — curl приклади для кожного ендпоінта
- [ ] **Key Decisions** — секція з поясненням trade-offs:
  - Чому TypeScript а не Rust
  - Чому Fastify а не Express
  - Чому JSONB для складних типів а не окремі таблиці
  - Як вирішили проблему cold start
  - Обмеження поточної реалізації та що можна покращити

### 6.4 Фінальна перевірка
- [ ] `docker compose up` — все запускається з нуля без додаткових кроків
- [ ] **Devnet тест**: запустити з `SOLANA_NETWORK=devnet`, переконатись що індексує
- [ ] **Mainnet тест**: запустити з Helius API key + Marinade IDL, проіндексувати ~500 tx
- [ ] Перевірити що batch mode і realtime mode перемикаються через `.env`
- [ ] Перевірити graceful shutdown: `Ctrl+C` не губить дані
- [ ] Перевірити повторний запуск: cold start підхоплює з місця зупинки
- [ ] GitHub repo: публічний, всі файли закомічені, `.env` в `.gitignore`, `.env.example` є

---

## Порядок виконання (рекомендований)

```
Фаза 1 (1-2 дні)  →  Фаза 2 (2-3 дні)  →  Фаза 3 (2 дні)
    ↓
Фаза 4 (3-4 дні)  →  Фаза 5 (2-3 дні)  →  Фаза 6 (1-2 дні)
```

**Загальний estimated час:** 11–16 днів при ~4год/день роботи.

**Мінімальний viable submission** (якщо часу мало):
Фаза 1 + Фаза 2 + Фаза 3 + 4.1 + 4.2 + 5.1 + 6.3 — це вже покриває більшість критеріїв суддів.