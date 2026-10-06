---
title: CLI
description: Generate secrets and key pairs, sign and verify bodies, send test events and receive webhooks locally.
---

The package ships a `vector` command.

```sh
npx @sweberdev/vector secret
```

| Command | What it does |
|---|---|
| `vector secret` | Prints a new `whsec_` secret |
| `vector keypair` | Prints a new Ed25519 key pair: the `whsk_` secret key for the sender, the `whpk_` public key for receivers |
| `vector sign --secret <s> [--id <id>] [--timestamp <unix>] [--file <path>]` | Prints the three `webhook-*` headers for a body from stdin or a file |
| `vector verify --secret <s> --id <id> --timestamp <unix> --signature <sig> [--file <path>]` | Checks a signature; exits with 1 if it does not match |
| `vector send <url> --secret <s> [--type <event>] [--data <json>] [--allow-private]` | Sends one signed event to a URL and prints the status |
| `vector listen [--port 4000] [--secret <s>]` | Starts a local receiver that prints every request, and verifies it when a secret is given (`401` if it does not match) |

## Examples

Test your receiver while you build it:

```sh
vector send http://localhost:3000/api/webhooks --secret whsec_... --allow-private \
  --type invoice.paid --data '{"invoiceId":"inv_123"}'
```

Watch what your app sends in development:

```sh
vector listen --port 4000 --secret whsec_...
```

and register `http://localhost:4000/` as an endpoint with `urlPolicy: { allowPrivateNetworks: true }`.

`vector verify` ignores the age of the timestamp unless you pass `--tolerance <seconds>`, so you can check requests copied from a log.

`--secret` also takes Ed25519 keys: `sign` and `send` with a `whsk_` key send `v1a` signatures, `verify` and `listen` check them with the `whpk_` public key.
