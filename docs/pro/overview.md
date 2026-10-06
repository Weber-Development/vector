---
title: Vector Pro
description: A customer webhook portal, a typed event catalog, alerts, recovery and metrics for production, verified inbound webhooks, and chat formats.
---

Vector Pro adds five packages to the free library. They cover what teams usually build next once webhooks are live, and what hosted services sell as their paid features. Like Vector itself, they run in your app and send nothing to us.

| Package | What it does |
|---|---|
| [`vector-portal`](portal.md) | An embeddable portal for your customers: a JSON API scoped to the signed-in tenant (Fetch API and Node `http`), a typed client and React components to manage endpoints, reveal and rotate secrets, send test events and read the delivery log with retries. |
| [`vector-catalog`](catalog.md) | A typed catalog of your event types. Payloads are validated with any Standard Schema validator (zod, valibot, arktype) before they are stored, and the same definition generates Markdown reference docs, an AsyncAPI 3.0 document and TypeScript types for your customers. |
| [`vector-ops`](ops.md) | Throttled alerts to Slack, email or a signed webhook when deliveries fail or endpoints are disabled, bulk recovery after an outage, health reports, Prometheus metrics and data retention for the PostgreSQL store. |
| [`vector-inbound`](inbound.md) | Webhooks you receive from Stripe, GitHub, Shopify, Standard Webhooks senders (Svix, Clerk, Resend) and HMAC-signed APIs: verified, stored once and forwarded to your services with Vector's retries, log and signatures. |
| [`vector-transform`](transform.md) | Messages in the format Slack, Microsoft Teams, Discord and Google Chat expect, written from templates per event type and escaped against mentions, plus pick, omit and redact of fields for every other endpoint. |

`vector-transform` needs `@sweberdev/vector` 0.3 or later; the other four need 0.1 or later.

## Licence and installation

Vector Pro is licensed per person: Freelancer (1 person), Agency (up to 10) and Lifetime (up to 10, one payment). After a purchase you get read access to the customer repository `Weber-Development/vector-pro-dist`; the packages are installed from GitHub Packages with a token. The full guide is `INSTALL.md` in that repository.

```ini
# .npmrc
@weber-development:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${VECTOR_PRO_TOKEN}
```

```sh
pnpm add @weber-development/vector-portal @weber-development/vector-catalog @weber-development/vector-ops @weber-development/vector-inbound @weber-development/vector-transform
```

After cancelling, every version you already received keeps working; only updates and repository access end. Prices and checkout: [packages.sweber.dev/vector](https://packages.sweber.dev/vector).
