# @sweberdev/vector

## 0.5.0

### Minor Changes

- b6b048b: New `hold` option: asked before every attempt how many seconds deliveries to an endpoint should wait. Held deliveries stay pending and are not counted as attempts. It is the building block for circuit breakers and pauses.

## 0.4.0

### Minor Changes

- d46935f: New `rateLimit` option: most requests per second to one endpoint, as one number, a function per endpoint, or `metadata.rateLimit` on the endpoint. Deliveries over the limit wait and are not counted as failed attempts. New `dispatcher` option passes an undici dispatcher (for example a `ProxyAgent`) to `fetch`, so deliveries can leave through an egress proxy with a fixed IP.

## 0.3.0

### Minor Changes

- c78684b: New `transform` option: change the body of a delivery per endpoint (other formats, fewer fields), add headers or skip the delivery. A throwing transform fails the attempt and is retried. Types `TransformFunction`, `TransformContext` and `TransformResult` are exported.

## 0.2.0

### Minor Changes

- 031ae93: Ed25519 (`v1a`) signatures from the Standard Webhooks spec: `signing: "ed25519"` on `createVector` or per endpoint, `endpoints.publicKey()`, `generateKeyPair()`, `publicKeyFor()` and `vector keypair`. `verify` accepts `whpk_` public keys. New SQLite (`@sweberdev/vector/sqlite`) and MySQL (`@sweberdev/vector/mysql`) stores.

## 0.1.0

### Minor Changes

- 98dc2f3: First release: Standard Webhooks signing and verification, endpoints per tenant with event type filters, delivery with retries and backoff, delivery log, SSRF protection, secret rotation, idempotency keys, memory and PostgreSQL stores, and the `vector` CLI.
