---
title: API reference
description: Every export of @sweberdev/vector and its PostgreSQL, SQLite and MySQL stores.
---

## Sending: `@sweberdev/vector`

### `createVector(options?)`

Returns a `Vector`. Options, all optional:

| Option | Default | |
|---|---|---|
| `store` | `new MemoryStore()` | Where data is kept |
| `retrySchedule` | `[5, 300, 1800, 7200, 18000, 36000, 36000]` | Seconds to wait after each failed attempt |
| `timeoutMs` | `15000` | Timeout per request |
| `maxResponseBytes` | `2048` | Response body stored per attempt |
| `maxPayloadBytes` | `262144` | Largest payload `send` accepts |
| `userAgent` | `Vector-Webhooks/1` | |
| `urlPolicy` | `{}` | `{ allowPrivateNetworks?, allowHttp?, resolveHost? }` |
| `disableEndpointAfter` | `10` | Failed deliveries in a row before an endpoint is disabled; `0` never |
| `disableOnGone` | `true` | Disable endpoints that answer `410` |
| `secretRotationGraceSeconds` | `86400` | How long the old secret keeps signing |
| `signing` | `"hmac"` | Scheme for new endpoints: `"hmac"` (`whsec_` secret, `v1`) or `"ed25519"` (`whsk_` key, `v1a`) |
| `envelope` | `true` | Body `{ type, timestamp, data }`; `false` sends the bare payload |
| `fetch`, `now`, `random` | globals | For tests |
| `onError` | `console.error` | Errors from listeners and the worker |

### `vector.endpoints`

| Method | Returns |
|---|---|
| `create(input)` | `Endpoint`. Input: `url`, `tenant?`, `description?`, `eventTypes?`, `headers?`, `metadata?`, `secret?`, `signing?`, `enabled?` |
| `get(id, scope?)` | `Endpoint \| undefined` |
| `list(query?)` | `Endpoint[]`. Query: `tenant?`, `limit?`, `before?` |
| `update(id, input, scope?)` | `Endpoint \| undefined`. Input: `url?`, `description?`, `eventTypes?`, `headers?`, `metadata?`, `enabled?` |
| `delete(id, scope?)` | `boolean` |
| `rotateSecret(id, { tenant?, secret?, graceSeconds? })` | `Endpoint \| undefined`; keeps the endpoint's scheme |
| `publicKey(id, scope?)` | `{ publicKey, previousPublicKey }` for Ed25519 endpoints, `null` for HMAC ones, `undefined` if missing |

`scope` is `{ tenant }`; items of other tenants are treated as missing.

### Messages and delivery

| Method | Returns |
|---|---|
| `send({ eventType, payload, tenant?, idempotencyKey?, endpointIds?, deliverNow? })` | `{ message, deliveries, duplicate }` |
| `sendTest(endpointId, { tenant?, payload? })` | `Delivery \| undefined` after one attempt |
| `process({ limit?, concurrency? })` | `{ claimed, succeeded, retrying, failed, cancelled }` |
| `start({ intervalMs?, limit?, concurrency? })` | `{ stop(): Promise<void> }` |
| `retry(deliveryId, scope?)` | `Delivery \| undefined` |
| `resend(messageId, { tenant?, endpointId? })` | `Delivery[]` |
| `messages.get(id, scope?)`, `messages.list({ tenant?, eventType?, since?, before?, limit? })` | |
| `deliveries.get(id, scope?)`, `deliveries.list({ tenant?, messageId?, endpointId?, status?, since?, before?, limit? })` | |
| `attempts.list({ tenant?, deliveryId?, messageId?, endpointId?, since?, before?, limit? })` | |
| `on(event, listener)` | unsubscribe function. Events: `attempt`, `delivery.succeeded`, `delivery.failed`, `endpoint.disabled` |

### Types

- `Endpoint`: `id`, `tenant`, `url`, `description`, `secret`, `previousSecret`, `previousSecretExpiresAt`, `eventTypes`, `headers`, `metadata`, `enabled`, `disabledReason`, `failureStreak`, `createdAt`, `updatedAt`
- `Message`: `id`, `tenant`, `eventType`, `payload`, `idempotencyKey`, `createdAt`
- `Delivery`: `id`, `messageId`, `endpointId`, `tenant`, `eventType`, `status` (`pending`, `succeeded`, `failed`, `cancelled`), `attempts`, `nextAttemptAt`, `lockedUntil`, `lastAttemptAt`, `lastStatusCode`, `lastError`, `createdAt`, `updatedAt`
- `Attempt`: `id`, `deliveryId`, `messageId`, `endpointId`, `tenant`, `at`, `durationMs`, `statusCode`, `success`, `error`, `responseBody`
- `VectorStore`: the storage interface; `MemoryStore` implements it

## Signing and verifying

| Export | |
|---|---|
| `generateSecret(bytes = 24)` | New `whsec_` secret |
| `generateKeyPair()` | `Promise<{ secretKey: "whsk_...", publicKey: "whpk_..." }>` (Ed25519) |
| `publicKeyFor(secretKey)` | `Promise<"whpk_...">` for a `whsk_` key |
| `sign({ id, timestamp, payload, secret })` | `Promise<"v1,...">`, or `"v1a,..."` with a `whsk_` key |
| `signHeaders({ id, timestamp, payload, secret, secrets? })` | The three `webhook-*` headers; extra `secrets` add signatures |
| `verify(payload, headers, key \| keys, { toleranceSeconds?, now? })` | `Promise<{ id, timestamp, payload, raw }>` or throws `WebhookVerificationError` |
| `verifyRequest(request, secret \| secrets, options?)` | Same, for a Fetch API `Request` |
| `new Webhook(secret \| secrets, options?)` | `.verify(payload, headers)`, `.sign(id, timestamp, payload)` |
| `WebhookVerificationError` | `.code`: `missing_headers`, `invalid_timestamp`, `timestamp_too_old`, `timestamp_too_new`, `no_matching_signature`, `invalid_payload` |
| `HEADER_ID`, `HEADER_TIMESTAMP`, `HEADER_SIGNATURE` | Header names |
| `SECRET_KEY_PREFIX`, `PUBLIC_KEY_PREFIX` | `"whsk_"`, `"whpk_"` |

Wherever a secret is taken, a key can be a `whsec_` secret (checks `v1`) or a `whpk_` public key (checks `v1a`); a `whsk_` key verifies with its public key.

## URL checks

| Export | |
|---|---|
| `assertDeliverableUrl(url, policy?)` | Resolves to a `URL` or throws `UrlNotAllowedError` |
| `isPrivateAddress(ip)` | `true` for loopback, private, link-local and reserved addresses |

## Event types

`matchesEventType(filter, eventType)` and `endpointWants(filters, eventType)` implement the filter rules (`invoice.paid`, `invoice.*`, `*`).

## `@sweberdev/vector/postgres`

| Export | |
|---|---|
| `createPostgresStore({ query, tablePrefix? })` | `PostgresStore` with `migrate()` |
| `postgresSchema(tablePrefix?)` | The `create table` SQL |
| `PostgresQuery` | `(text, params) => Promise<{ rows }>` |

## `@sweberdev/vector/sqlite`

| Export | |
|---|---|
| `createSqliteStore({ database, tablePrefix? })` | `SqliteStore` with `migrate()`; `database` is a `node:sqlite` `DatabaseSync` or a `better-sqlite3` database |
| `sqliteSchema(tablePrefix?)` | The `create table` SQL |

## `@sweberdev/vector/mysql`

| Export | |
|---|---|
| `createMysqlStore({ query, tablePrefix? })` | `MysqlStore` with `migrate()` |
| `mysql2Query(pool)` | Adapts a `mysql2/promise` pool or connection to `query` |
| `mysqlSchema(tablePrefix?)` | The `create table` SQL |
| `MysqlQuery` | `(sql, params) => Promise<{ rows, affectedRows }>` |
