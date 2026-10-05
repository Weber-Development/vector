---
title: Getting started
description: Install Vector, register an endpoint, send an event and verify it on the receiving side.
---

## Install

```sh
pnpm add @sweberdev/vector
```

Vector needs Node.js 20.16 or newer for sending. Verifying also works in browsers, edge runtimes, Bun and Deno.

## Send

```ts
import { createVector } from "@sweberdev/vector";

const vector = createVector();

// Usually done by your customer in your settings UI.
const endpoint = await vector.endpoints.create({
  url: "https://example.com/webhooks",
  tenant: "acme", // your customer's id
  eventTypes: ["invoice.*"],
});
console.log(endpoint.secret); // whsec_...  show this once to your customer

await vector.send({
  tenant: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "inv_123", amount: 4200, currency: "CHF" },
});

// Deliver everything that is due. In a server, use vector.start() instead.
await vector.process();
```

The endpoint receives a `POST` with this body:

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-10-05T12:00:00.000Z",
  "data": { "invoiceId": "inv_123", "amount": 4200, "currency": "CHF" }
}
```

and the headers `webhook-id`, `webhook-timestamp` and `webhook-signature`.

`createVector()` without options keeps everything in memory, which is fine for trying it out. For production use the [PostgreSQL store](guides/postgres.md) and run a [worker](guides/workers.md).

## Receive

```ts
// app/api/webhooks/route.ts (Next.js)
import { verifyRequest, WebhookVerificationError } from "@sweberdev/vector";

export async function POST(request: Request) {
  try {
    const { id, payload } = await verifyRequest(request, process.env.WEBHOOK_SECRET!);
    // Use `id` to ignore duplicates, then handle payload.type and payload.data.
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    throw error;
  }
}
```

Your customers can use any [Standard Webhooks](https://www.standardwebhooks.com) library instead, in any language. See [Receiving webhooks](guides/receiving.md).

## Try it locally

```sh
npx @sweberdev/vector secret                 # prints a new whsec_ secret
npx @sweberdev/vector listen --secret whsec_...   # receiver on http://localhost:4000
```

In development, allow local URLs:

```ts
const vector = createVector({ urlPolicy: { allowPrivateNetworks: true } });
```
