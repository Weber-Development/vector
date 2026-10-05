---
title: Receiving webhooks
description: Verify Vector webhooks in Next.js, Express, Hono and other frameworks, or with any Standard Webhooks library.
---

This page is for whoever receives the webhooks: your customers, or you when you test. Share it with them.

## What arrives

```http
POST /webhooks HTTP/1.1
content-type: application/json
webhook-id: msg_2kq9x0a4bcd8e7f6g5h4j3k2m1
webhook-timestamp: 1759665600
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"type":"invoice.paid","timestamp":"2026-10-05T12:00:00.000Z","data":{"invoiceId":"inv_123"}}
```

- `webhook-id` is the same on every retry of a message. Store it and ignore ids you have seen.
- `webhook-timestamp` is the time of this attempt in Unix seconds. Requests older than five minutes are rejected, which stops replays.
- `webhook-signature` is `v1,` plus the base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`, keyed with the secret without its `whsec_` prefix (base64-decoded). During a secret rotation it contains two signatures separated by a space.

Answer with any 2xx status within 15 seconds. Do the real work in the background if it takes longer. Anything else, a timeout or a redirect counts as a failure and is retried.

## Verify

Always verify against the **raw body** exactly as it arrived. Parsing the JSON and serialising it again changes the bytes and the signature no longer matches.

### Fetch API (Next.js, Hono, Remix, Bun, Deno, Cloudflare Workers)

```ts
import { verifyRequest } from "@sweberdev/vector";

const { id, payload } = await verifyRequest(request, process.env.WEBHOOK_SECRET!);
```

### Express

```ts
import express from "express";
import { verify, WebhookVerificationError } from "@sweberdev/vector";

app.post("/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const { payload } = await verify(req.body, req.headers, process.env.WEBHOOK_SECRET!);
    res.sendStatus(204);
    void handle(payload);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(401);
    throw error;
  }
});
```

`verify` takes the body as a string or bytes, the headers as a `Headers` object, a plain object or entries, and one secret or a list of secrets.

### Class API

```ts
import { Webhook } from "@sweberdev/vector";

const wh = new Webhook(process.env.WEBHOOK_SECRET!);
const payload = await wh.verify(body, headers);
```

This mirrors the `standardwebhooks` and `svix` packages, except that `verify` returns a promise because it uses Web Crypto.

### Other languages

Vector follows the [Standard Webhooks](https://www.standardwebhooks.com) specification, so receivers can use its official libraries (Python, Go, PHP, Ruby, Java, Rust, C#, Elixir) or the Svix SDKs. Vector also accepts `svix-id`, `svix-timestamp` and `svix-signature` headers when verifying.

## Errors

`WebhookVerificationError` has a `code`:

| Code | Meaning |
|---|---|
| `missing_headers` | One of the three headers is missing |
| `invalid_timestamp` | The timestamp is not a number |
| `timestamp_too_old` / `timestamp_too_new` | More than `toleranceSeconds` (default 300) away from now |
| `no_matching_signature` | Wrong secret, or the body was changed or re-serialised |
| `invalid_payload` | The signature is fine but the body is not JSON |

## Rotating the secret

When the sender rotates the secret, requests carry signatures for the old and the new secret for a grace period (24 hours by default). Switch to the new secret any time within it, or pass both while you switch: `verify(body, headers, [oldSecret, newSecret])`.
