# Vector

Self-hosted webhooks for Node.js and TypeScript. Vector signs, sends, retries and logs the webhooks your product sends to its customers, and verifies them on the other side. It follows the [Standard Webhooks](https://www.standardwebhooks.com) specification (the format Svix uses), keeps its data in your own PostgreSQL, MySQL or SQLite, and has no dependencies.

```sh
pnpm add @sweberdev/vector
```

```ts
import { createVector } from "@sweberdev/vector";
import { createPostgresStore } from "@sweberdev/vector/postgres";

const vector = createVector({ store: createPostgresStore({ query: (t, p) => pool.query(t, p) }) });

const endpoint = await vector.endpoints.create({
  tenant: "acme",
  url: "https://example.com/webhooks",
  eventTypes: ["invoice.*"],
});

await vector.send({ tenant: "acme", eventType: "invoice.paid", payload: { invoiceId: "inv_123" } });
vector.start(); // delivers, retries for ~27 hours, logs every attempt
```

```ts
// On the receiving side
import { verifyRequest } from "@sweberdev/vector";

const { id, payload } = await verifyRequest(request, process.env.WEBHOOK_SECRET!);
```

- HMAC-SHA256 signatures with `webhook-id`, `webhook-timestamp` and `webhook-signature`, compatible with the Standard Webhooks and Svix libraries, or Ed25519 public-key signatures (`v1a`) so receivers cannot forge requests
- Endpoints per tenant with event type filters, custom headers and their own secret
- Eight attempts with exponential backoff and jitter, `Retry-After`, timeouts, automatic disabling of dead endpoints
- A log of every message, delivery and attempt; retry and resend with one call
- SSRF protection: no localhost, private networks or cloud metadata, checked again before every attempt
- Secret rotation with a grace period, idempotency keys, test events
- In-memory, PostgreSQL (`pg`, postgres.js, Neon, Supabase, PGlite), MySQL (`mysql2`) and SQLite (`node:sqlite`, `better-sqlite3`) stores, safe with several workers
- `vector` CLI: secrets, key pairs, sign, verify, send test events, receive locally

| Package | |
|---|---|
| [`@sweberdev/vector`](packages/core) | Sender, verifier, memory, PostgreSQL, MySQL and SQLite stores, CLI |

Docs and live demo: [packages.sweber.dev/vector](https://packages.sweber.dev/vector)

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Releases use Changesets: add a changeset with `pnpm changeset`; merging the "version packages" PR publishes to npm.

## Licence

MIT. Vector Pro (customer portal, typed event catalog, alerts and operations tooling) is a separate commercial product: [packages.sweber.dev/vector](https://packages.sweber.dev/vector).
