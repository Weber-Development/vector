# @sweberdev/vector

## 0.2.0

### Minor Changes

- 031ae93: Ed25519 (`v1a`) signatures from the Standard Webhooks spec: `signing: "ed25519"` on `createVector` or per endpoint, `endpoints.publicKey()`, `generateKeyPair()`, `publicKeyFor()` and `vector keypair`. `verify` accepts `whpk_` public keys. New SQLite (`@sweberdev/vector/sqlite`) and MySQL (`@sweberdev/vector/mysql`) stores.

## 0.1.0

### Minor Changes

- 98dc2f3: First release: Standard Webhooks signing and verification, endpoints per tenant with event type filters, delivery with retries and backoff, delivery log, SSRF protection, secret rotation, idempotency keys, memory and PostgreSQL stores, and the `vector` CLI.
