---
title: Public-key signatures
description: Sign webhooks with Ed25519 so receivers only hold a public key and cannot forge requests.
---

By default every endpoint has a `whsec_` secret that both sides share: Vector signs with it and the receiver checks the HMAC with the same secret. Anyone who has the secret can therefore also create valid webhooks.

With Ed25519, the [Standard Webhooks](https://www.standardwebhooks.com) asymmetric scheme, Vector keeps a `whsk_` **secret key** and the receiver gets only the `whpk_` **public key**. A leaked public key lets nobody send fake webhooks, which matters when you hand keys to many customers, or when a receiver's config ends up in a log or a frontend.

## Sending

Switch all new endpoints to Ed25519:

```ts
const vector = createVector({ store, signing: "ed25519" });
```

or choose per endpoint:

```ts
const endpoint = await vector.endpoints.create({
  url: "https://example.com/webhooks",
  tenant: "acme",
  signing: "ed25519",
});
const keys = await vector.endpoints.publicKey(endpoint.id, { tenant: "acme" });
// { publicKey: "whpk_...", previousPublicKey: null }
```

Show `keys.publicKey` to your customer instead of the secret. `publicKey` returns `null` for HMAC endpoints and `undefined` for unknown ones.

Requests then carry `webhook-signature: v1a,<base64>`: an Ed25519 signature over the same `{id}.{timestamp}.{body}` content as `v1`. Existing HMAC endpoints keep working unchanged; a store can hold both kinds.

To bring your own key pair, pass the `whsk_` key as `secret` to `create` or `rotateSecret`. `generateKeyPair()` and `publicKeyFor(secretKey)` create and derive keys in code, `vector keypair` on the command line.

## Rotating

`rotateSecret` keeps the scheme: an Ed25519 endpoint gets a new key pair. During the grace period (24 hours by default) requests carry signatures from the old and the new key, and `publicKey` returns the old one as `previousPublicKey`, so receivers can switch whenever they like.

## Receiving

`verify`, `verifyRequest` and `Webhook` take the public key where they take a secret:

```ts
const { payload } = await verifyRequest(request, process.env.WEBHOOK_PUBLIC_KEY!); // whpk_...
```

A `whpk_` key only accepts `v1a` signatures and a `whsec_` secret only `v1`, so a receiver can never be tricked into the weaker check. Pass several keys during a rotation: `verify(body, headers, [oldKey, newKey])`.

Receivers in other languages can use any Ed25519 library: decode the part after `whpk_` from base64 (32 bytes), decode the part after `v1a,` (64 bytes) and verify it against the bytes of `{id}.{timestamp}.{body}`.

## Requirements

Ed25519 uses the Web Crypto API, available in Node.js 20.16+ (the minimum for Vector), Deno, Bun, Cloudflare Workers and current browsers.
