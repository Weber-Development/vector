---
title: Security
description: Signatures, secret handling and rotation, and the protection against server-side request forgery.
---

## Signatures

Every request is signed with HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}` using the endpoint's secret. The timestamp is part of the signature and receivers reject requests older than five minutes, so a captured request cannot be replayed later. Signatures are compared in constant time.

## Secrets

Each endpoint has its own random 24-byte secret in the `whsec_` format. Show it to your customer when the endpoint is created and behind an explicit "reveal" action afterwards; do not put it in list views or logs.

Secrets are stored as they are in your store, because Vector needs them to sign. Protect the database accordingly (encryption at rest, restricted access).

### Rotation

```ts
const endpoint = await vector.endpoints.rotateSecret(id, { graceSeconds: 86_400 });
```

creates a new secret. For the grace period (default 24 hours, `secretRotationGraceSeconds`) every request carries two signatures, one per secret, so the receiver can switch whenever it suits them. Pass `graceSeconds: 0` to revoke a leaked secret at once.

## Server-side request forgery (SSRF)

Endpoint URLs come from your customers. Without a check, a customer could register `http://169.254.169.254/latest/meta-data/` or `http://localhost:6379/` and make your server send requests into your own network. Vector refuses by default:

- schemes other than `https`
- user name or password in the URL
- `localhost`, `*.localhost` and `*.internal`
- IPv4 loopback, private (10/8, 172.16/12, 192.168/16), carrier-grade NAT, link-local (169.254/16, including cloud metadata), multicast, documentation and reserved ranges, also when written as decimal or hex
- IPv6 loopback, unique-local, link-local, multicast, and IPv4-mapped or NAT64 forms of the above
- host names that resolve to any of these

The check runs when an endpoint is created or its URL changed, and again before every attempt, because DNS can change. Redirects are never followed.

```ts
createVector({
  urlPolicy: {
    allowPrivateNetworks: process.env.NODE_ENV !== "production", // also allows http
    resolveHost: myResolver, // optional, defaults to node:dns
  },
});
```

`assertDeliverableUrl(url, policy)` and `isPrivateAddress(ip)` are exported if you want the same check elsewhere, for example to validate a form before saving.

**Limits.** Between the check and the request, a host name could in theory resolve differently (DNS rebinding with a very short TTL). For untrusted endpoints at scale, also send webhooks through an egress proxy that blocks private networks, or from a network segment without access to internal services. On runtimes without DNS access (edge), only IP literals and host names are checked.
