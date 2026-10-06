---
title: Inbound webhooks
description: "vector-inbound: receive webhooks from Stripe, GitHub, Shopify and others, verified, stored once and forwarded."
---

Part of Vector Pro. Receive webhooks from Stripe, GitHub, Shopify, Standard Webhooks senders (Svix, Clerk, Resend and others) and any HMAC-signed API with [`@sweberdev/vector`](https://packages.sweber.dev/vector). Every request is verified, stored once and then forwarded to your own services with Vector's retries, delivery log and signatures.

Why not handle provider webhooks directly in a route? Because the provider stops retrying once you answer, so an event your code fails to process after a 200 is gone, and a slow handler causes timeouts and duplicate deliveries. With inbound, the route only verifies and stores; the work happens behind Vector's queue, where a failed attempt is retried for hours and can be replayed from the log.

## Set up

```ts
import { createVector } from "@sweberdev/vector";
import { createInbound, github, standardWebhooks, stripe } from "@weber-development/vector-inbound";

export const inbound = createInbound(vector, {
  sources: {
    stripe: stripe({ secret: process.env.STRIPE_WEBHOOK_SECRET! }),
    github: github({ secret: process.env.GITHUB_WEBHOOK_SECRET! }),
    clerk: standardWebhooks({ secret: process.env.CLERK_WEBHOOK_SECRET! }),
  },
});
```

Point each provider at `https://your-app.example.com/webhooks/<source>`, e.g. `/webhooks/stripe`.

Next.js (`app/webhooks/[source]/route.ts`), Hono, Bun, Deno, Cloudflare Workers:

```ts
export const POST = (request: Request) => inbound.handler(request);
```

Express: the signature is over the raw body, so use `express.raw()` for this route, not `express.json()`:

```ts
import { toNodeHandler } from "@weber-development/vector-inbound";

app.post("/webhooks/:source", express.raw({ type: "*/*" }), toNodeHandler(inbound));
```

Anything else: `await inbound.receive("stripe", { body: rawBody, headers })` returns the result with the HTTP status to answer.

## Forward

Events are stored as Vector messages of the tenant `inbound`, with the source as prefix of the event type: `stripe.invoice.paid`, `github.pull_request.opened`, `shopify.orders.create`, `clerk.user.created`. Create endpoints for your services as usual:

```ts
await vector.endpoints.create({
  tenant: "inbound",
  url: "https://billing.internal.example.com/events",
  eventTypes: ["stripe.invoice.*", "stripe.customer.subscription.*"],
});
```

The worker (`vector.start()` or `vector.process()`) then delivers each event with up to eight attempts, logs every attempt and signs it with the endpoint's Standard Webhooks secret, so all your services verify one format with `verifyRequest` from `@sweberdev/vector`, whatever the provider. The body is `{ type, timestamp, data }` with the provider's payload as `data`. Internal URLs need Vector's `urlPolicy: { allowPrivateNetworks: true }`.

Because these are ordinary Vector messages, the delivery log, `vector.retry`, `vector.resend` and Vector Pro's portal, alerts and recovery work for them too.

## Sources

| Source | Verifies | Event type | Id used for deduplication |
|---|---|---|---|
| `stripe({ secret, toleranceSeconds? })` | `Stripe-Signature` (HMAC-SHA256, 300 s tolerance) | `type`, e.g. `invoice.paid` | event `id` |
| `github({ secret })` | `X-Hub-Signature-256` | `X-GitHub-Event` plus `action`, e.g. `pull_request.opened` | `X-GitHub-Delivery` |
| `shopify({ secret })` | `X-Shopify-Hmac-Sha256` | `X-Shopify-Topic`, `orders/create` becomes `orders.create` | `X-Shopify-Event-Id` |
| `standardWebhooks({ secret, toleranceSeconds? })` | `webhook-*` or `svix-*` headers, `whsec_` secrets and `whpk_` public keys | payload `type`; a `{ type, data }` envelope is unwrapped | `webhook-id` |
| `hmacSource({ secret, header, algorithm?, encoding?, prefix?, idHeader?, eventType, timestampHeader? })` | HMAC over the body (or `{timestamp}.{body}`), SHA-1/256/512, hex or base64 | a header or a function of the payload | `idHeader`, else the body's SHA-256 |

`secret` takes a list during a rotation; a request signed with any of them is accepted. GitHub webhooks must use the content type `application/json`. A source is any object with `provider` and `verify({ body, headers, now })`, so you can add your own.

## Answers

| Status | HTTP | When |
|---|---|---|
| `accepted` | 200 | Verified and stored |
| `duplicate` | 200 | The provider sent the same event again; nothing is stored twice |
| `ignored` | 200 | The event type is not in `accept` |
| `rejected` | 401 or 400 | Wrong signature, missing headers, too old, or not JSON |
| `unknown_source` | 404 | No source with that name |
| `too_large` | 413 | Over `maxBodyBytes` (1 MiB) or Vector's `maxPayloadBytes` (256 KiB by default) |
| `error` | 500 | Storing failed; the provider retries later |

The provider gets `{ status, id }` or `{ error: { code, message } }`. Internal error messages are only passed to `onResult`.

## Options

| Option | Default | |
|---|---|---|
| `sources` | | Source name to verifier |
| `tenant` | `"inbound"` | Vector tenant of the stored messages; `null` for none |
| `accept` | everything | Event type filters such as `["stripe.invoice.*", "github.push"]`; others are answered 200 and dropped |
| `maxBodyBytes` | `1048576` | Larger requests get 413 |
| `deliverNow` | `false` | Forward before answering the provider. Leave it off unless your services are fast: providers time out after a few seconds |
| `onResult` | | Called with every result, for logging and metrics |

GitHub push events can be larger than Vector's default `maxPayloadBytes` of 256 KiB; raise it in `createVector` if you receive them.

## Licence

Vector Pro licence, see `LICENSE.md`.
