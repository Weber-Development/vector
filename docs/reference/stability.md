---
title: Stability and versioning
description: What counts as Vector's public API, what a breaking change is, and how deprecations work.
---

Vector follows [semantic versioning](https://semver.org). From 1.0.0 on, a breaking change to anything listed below only ships in a new major version. Before 1.0.0 (versions 0.x), minor versions could change things; 0.7.0 was the frozen release candidate and 1.0.0 has the same API.

## What is public API

- **Everything exported from `@sweberdev/vector`, `/postgres`, `/sqlite` and `/mysql`**, including types: `createVector`, the `Vector` methods and namespaces (`endpoints`, `messages`, `deliveries`, `attempts`), `verify` and the signing functions, `createPostgresStore`, `createSqliteStore`, `createMysqlStore`, the deduper functions and `VectorStore` for custom stores.
- **Options and their defaults.** Changing a default in a way that changes behaviour (retry schedule, timeouts, size limits, URL policy) is a breaking change.
- **The wire format**: headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`), the signed content, the `v1` and `v1a` schemes and the default envelope `{ type, timestamp, data }`. Receivers built on Standard Webhooks or Svix libraries must keep working.
- **The database schema** of the four tables (and `vector_seen`): columns and indexes are only added, never removed or retyped, within a major version. `migrate()` and the exported schema functions are idempotent, so they are safe to run on every deploy.
- **The command line** (`vector` binary): commands, flags and exit codes.
- **Event names** of `vector.on(...)` and the shape of their payloads.

## What is not public

- Anything not exported from the entry points above, including files under `dist/`.
- Exact wording of error messages and log output. Match on error classes and codes instead.
- Timing within the documented bounds: the order in which due deliveries are picked up, the exact jitter, the lock duration while a delivery is in flight.
- Internals of the Pro packages' storage tables beyond what their docs describe.

## What counts as breaking

Removing or renaming an export, option or method; making an optional field required; narrowing accepted input; changing a return type in an incompatible way; changing a documented default in a way that changes behaviour; dropping support for a Node.js version that has not reached end of life; changing a column or removing an index. Bug fixes that make Vector match its documentation are not breaking, even if someone relied on the bug.

Not breaking: new exports, options with a default that keeps today's behaviour, new optional fields in results, new event types, new columns with defaults, stricter handling of input that was already invalid.

## Deprecation

A feature is deprecated in a minor version first: it keeps working, is marked `@deprecated` in the types with the replacement named, and is listed in the changelog. It is removed no earlier than the next major version.

## Supported platforms

Node.js 20.16 and newer, plus Bun and Deno where the dependencies allow. The package has no runtime dependencies. When a Node.js version reaches end of life, support for it ends in the next major version.

## Vector Pro

The Pro packages follow the same rules for their own exports and are released together under one version number. Each Pro package declares which versions of `@sweberdev/vector` it works with as a peer dependency; a Pro release never requires a newer major version of the free package than the one current at its release. See the [Pro overview](../pro/overview.md).
