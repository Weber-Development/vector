# @sweberdev/vector

Self-hosted webhooks for Node.js and TypeScript: Standard Webhooks signatures (HMAC or Ed25519), retries with backoff, a delivery log, SSRF protection and stores for PostgreSQL, MySQL and SQLite. A Svix alternative that runs in your app.

```sh
pnpm add @sweberdev/vector
```

## Send

```ts
import { createVector } from "@sweberdev/vector";

const vector = createVector();

const endpoint = await vector.endpoints.create({
  tenant: "acme",
  url: "https://example.com/webhooks",
  eventTypes: ["invoice.*"],
});

await vector.send({
  tenant: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "inv_123", amount: 4200 },
});

const worker = vector.start(); // or call vector.process() from a cron job
```

For production, keep the data in PostgreSQL:

```ts
import { createPostgresStore } from "@sweberdev/vector/postgres";

const store = createPostgresStore({ query: (text, params) => pool.query(text, params) });
await store.migrate();
const vector = createVector({ store });
```

`@sweberdev/vector/mysql` and `@sweberdev/vector/sqlite` work the same way.

## Receive

```ts
import { verifyRequest, WebhookVerificationError } from "@sweberdev/vector";

export async function POST(request: Request) {
  try {
    const { id, payload } = await verifyRequest(request, process.env.WEBHOOK_SECRET!);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw error;
  }
}
```

## CLI

```sh
npx @sweberdev/vector secret
npx @sweberdev/vector keypair   # Ed25519: whsk_ for you, whpk_ for receivers
npx @sweberdev/vector listen --secret whsec_...
npx @sweberdev/vector send https://example.com/webhooks --secret whsec_...
```

## Docs

[packages.sweber.dev/vector/docs](https://packages.sweber.dev/vector/docs)

## Licence

MIT
