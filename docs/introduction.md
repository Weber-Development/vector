---
title: Introduction
description: What Vector is, how it compares to hosted webhook services, and what it does not do.
---

Vector sends webhooks from your Node.js app to your customers' servers, and verifies them on the receiving side. It is a library, not a service: it runs in your app, keeps its data in your database, and sends nothing to anyone else.

If your product offers webhooks, you need more than a `fetch` in a loop: signatures so receivers can trust the request, retries with backoff when their server is down, a log of what was sent, a way to resend, protection against customers pointing a webhook at your internal network, and secret rotation. Hosted services such as Svix or Hookdeck do this for a monthly fee and see all of your event data. Vector does it inside your own infrastructure.

## What you get

- **Standard Webhooks signatures.** HMAC-SHA256 with the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers from the [Standard Webhooks](https://www.standardwebhooks.com) specification, the same format Svix uses. Receivers can verify with Vector, the official `standardwebhooks` libraries or the Svix SDKs.
- **Endpoints per tenant.** Each of your customers registers their own URLs, with event type filters (`invoice.*`), custom headers and their own secret.
- **Reliable delivery.** Eight attempts over about 27 hours with jitter, `Retry-After` support, timeouts, no redirects, and automatic disabling of endpoints that keep failing or answer `410 Gone`.
- **A full log.** Every message, every delivery and every HTTP attempt with status code, duration and the start of the response body. Retry a delivery or resend a message with one call.
- **SSRF protection.** Endpoint URLs must be public `https` URLs. Loopback, private ranges, link-local addresses (cloud metadata at `169.254.169.254`), IPv6 private ranges and host names that resolve to them are refused, and the check runs again before every attempt.
- **Secret rotation** without downtime: during a grace period every request carries signatures with the old and the new secret.
- **Storage you own.** An in-memory store for tests and a PostgreSQL store (works with `pg`, postgres.js, Neon, Supabase, PGlite) that is safe with several workers. Or implement the small `VectorStore` interface for your database.
- **Idempotency keys**, so sending the same event twice creates one message.
- **A CLI** to generate secrets, sign and verify bodies, send test events and receive webhooks locally.
- **No dependencies.** Signing uses Web Crypto, so the receiving side also runs in browsers, edge runtimes, Bun and Deno.

## Vector Pro

[Vector Pro](pro/overview.md) adds what you would otherwise build next: an embeddable portal where your customers manage their endpoints and see their delivery log, a typed event catalog that validates payloads and generates docs and an AsyncAPI file, and operations tooling with alerts, bulk recovery, health reports, Prometheus metrics and data retention.

## What Vector does not do

- It is not a hosted service. You run the worker (or a cron job) that delivers due webhooks.
- It does not receive and fan out webhooks from third parties (that is an inbound gateway like Hookdeck).
- It does not guarantee ordering. Webhooks may arrive out of order and, after a retry, more than once; receivers should use `webhook-id` to deduplicate. This is how every webhook system behaves.
- It does not sign with asymmetric keys (`v1a`, Ed25519) yet.
