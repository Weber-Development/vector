---
title: Standalone server
description: "vector-server: Vector as a service for applications in any language, with a REST API, admin page, portal tokens, metrics, regions and tenant limits."
---

Part of Vector Pro (2.1). Run [`@sweberdev/vector`](https://packages.sweber.dev/vector) as a standalone service for applications that are not written in Node.js: PHP, Python, Go, Ruby, Java, anything that can send an HTTP request. One process holds the database connection, delivers the webhooks with Vector's retries and signatures, and comes with a REST API, an admin page, portal access for your customers, Prometheus metrics, regions and tenant limits.

It needs `@sweberdev/vector` 2.0 or later. The Docker image already contains everything.

## Run it

**Docker.** Log in to the GitHub container registry with your Vector Pro token (`docker login ghcr.io`, see `INSTALL.md` in the Vector Pro repository), then:

```bash
docker run -d -p 3000:3000 \
  -e VECTOR_API_KEY="$(openssl rand -hex 24)" \
  -e DATABASE_URL="postgres://user:password@db:5432/vector" \
  ghcr.io/weber-development/vector-server:latest
```

With Docker Compose and Postgres:

```yaml
services:
  vector:
    image: ghcr.io/weber-development/vector-server:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      VECTOR_API_KEY: ${VECTOR_API_KEY:?set a key of 16 characters or more}
      DATABASE_URL: postgres://vector:${DB_PASSWORD:?}@db:5432/vector
      VECTOR_RETENTION_DAYS: "90"
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: vector
      POSTGRES_PASSWORD: ${DB_PASSWORD:?}
      POSTGRES_DB: vector
    volumes: ["db:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vector"]
      interval: 5s
      retries: 10
volumes:
  db: {}
```

**Node.js** (as a package from GitHub Packages):

```bash
npm install @weber-development/vector-server @sweberdev/vector pg
VECTOR_API_KEY=… DATABASE_URL=postgres://… npx vector-server
```

On start the server creates or upgrades its tables (`VECTOR_MIGRATE=false` turns that off), starts the delivery worker and listens on `PORT` (default 3000). `SIGTERM` stops the worker, finishes running requests and closes the database.

## Configuration

All settings are environment variables.

| Variable | Meaning |
|---|---|
| `VECTOR_API_KEY` | **Required.** Admin key, 16 characters or more. Several keys, comma separated, allow rotation without downtime. |
| `DATABASE_URL` | `postgres://…`, `mysql://…`, or `sqlite:/data/vector.db`. Without it everything is kept in memory and lost on restart. |
| `PORT`, `HOST` | Default `3000` and `0.0.0.0`. |
| `VECTOR_SIGNING` | `hmac` (default) or `ed25519` for new endpoints. |
| `VECTOR_RETRY_SCHEDULE` | Seconds between retries, e.g. `5,300,3600`. |
| `VECTOR_ALLOW_PRIVATE_URLS` | `true` allows `http:` and private addresses. Development only. |
| `VECTOR_WORKER` | `false` runs an API-only process; run workers elsewhere. |
| `VECTOR_WORKER_CONCURRENCY`, `VECTOR_WORKER_INTERVAL_MS` | Parallel requests per pass (10) and idle pause (1000). |
| `VECTOR_RETENTION_DAYS` | Delete messages older than this, once an hour. Messages with a pending delivery stay. |
| `VECTOR_REGIONS`, `VECTOR_DEFAULT_REGION`, `VECTOR_TENANT_REGIONS` | Regions, see below. |
| `VECTOR_LIMITS` | Tenant limits, see below. |
| `VECTOR_PORTAL_SECRET` | Signs portal tokens. Default: derived from the first API key. |
| `VECTOR_PORTAL_CORS_ORIGINS` | Origins (comma separated, or `*`) that may call `/portal` from a browser. |

## Send events from any language

```bash
curl -X POST http://localhost:3000/v1/endpoints \
  -H "authorization: Bearer $VECTOR_API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://customer.example.com/hooks","tenant":"acme","eventTypes":["invoice.*"]}'

curl -X POST http://localhost:3000/v1/messages \
  -H "authorization: Bearer $VECTOR_API_KEY" -H "content-type: application/json" \
  -d '{"eventType":"invoice.paid","tenant":"acme","payload":{"id":"inv_1","amount":1200},"idempotencyKey":"inv_1"}'
```

The receiver gets a [Standard Webhooks](https://www.standardwebhooks.com) request signed with the endpoint's secret, retried on failure.

| Route | Purpose |
|---|---|
| `POST /v1/messages`, `POST /v1/messages/batch` | Send one event or up to 1000. Fields: `eventType`, `payload`, `tenant`, `idempotencyKey`, `orderingKey`, `endpointIds`. |
| `GET /v1/messages`, `GET /v1/messages/:id` | List (`tenant`, `eventType`, `since`, `before`, `limit`) and read with deliveries and attempts. |
| `POST /v1/messages/:id/resend` | Deliver again to all (or one `endpointId`) endpoints. |
| `GET/POST /v1/endpoints`, `GET/PATCH/DELETE /v1/endpoints/:id` | Manage endpoints. `GET /:id` shows the secret. |
| `POST /v1/endpoints/:id/test`, `/replay`, `/rotate-secret` | Test event, replay a time range, rotate the secret. |
| `GET /v1/deliveries?status=failed`, `POST /v1/deliveries/:id/retry` | Find and retry failed deliveries. |
| `POST /v1/portal-tokens` | Short-lived token for the tenant portal (below). |
| `GET /v1/tenants`, `/v1/stats`, `/v1/controls` | Tenants, success rate and backlog, regions and limits in use. |
| `GET /healthz`, `/readyz` | Liveness and readiness (no key). |
| `GET /metrics` | Prometheus metrics (key required: use `bearer_token` in the scrape config). |

Tenant filters: `?tenant=acme`, or `?noTenant=1` for items without a tenant. Errors look like `{"error":{"code":"invalid_request","message":"…"}}`.

## Admin page

Open `/admin`, enter an API key and you can see the success rate and backlog, manage endpoints per tenant, search messages, read every attempt, retry failed deliveries, send test events and replay a time range. The key stays in the browser tab. The page loads nothing from other sites and is served with a strict content security policy.

## Portal for your customers

`POST /v1/portal-tokens` with `{"tenant":"acme","ttlSeconds":3600}` returns a token. Give it to your customer's browser and it can use the [portal API](https://www.npmjs.com/package/@weber-development/vector-portal) under `/portal` (endpoints, log, replay, retries) for exactly that tenant, until it expires. Use the typed client or the React components from `@weber-development/vector-portal` with `baseUrl` set to `https://your-host/portal` and the token as the bearer token. Set `VECTOR_PORTAL_CORS_ORIGINS` when the browser calls the server directly.

## Regions

A region is a named way out to the internet: an HTTP proxy with a fixed IP, for example. Customers who allow-list your IP get an endpoint in the region that matches.

```bash
VECTOR_REGIONS='{"eu":{"proxy":"http://proxy-eu.internal:3128","description":"Frankfurt"},"us":{"proxy":"http://proxy-us.internal:3128"}}'
VECTOR_DEFAULT_REGION=eu
VECTOR_TENANT_REGIONS='{"globex":"us"}'
```

An endpoint picks its region with `metadata.region`; otherwise its tenant's region applies, then the default. Endpoints with a region the server does not know are refused. Without a proxy a region is just a label for dashboards (`"eu":{}`).

A region is an outgoing route, not a data location: all data stays in the one database you configured.

## Tenant limits

```bash
VECTOR_LIMITS='{"default":{"perSecond":20,"maxConcurrent":10},"tenants":{"acme":{"perSecond":100,"perDay":500000}}}'
```

| Limit | Effect over the limit |
|---|---|
| `perSecond` | Requests of all of a tenant's endpoints per second. Deliveries wait and are not counted as attempts. |
| `maxConcurrent` | Requests in flight at the same time. Further requests wait for a free slot. |
| `perDay` | Requests per UTC day. Deliveries wait until the next day starts. |

Per endpoint, set `metadata.rateLimit` (requests per second), `metadata.maxConcurrent` and `metadata.dailyLimit` as strings. Counters live in the memory of the process: with several workers each applies the limits on its own, so divide the numbers by the worker count if you need a hard total.

## Behind a proxy or load balancer

Terminate TLS in front of the server. Send `/admin`, `/v1` and `/metrics` only to people and systems that need them. The API key is the only protection of those routes. `/portal` is protected by its tokens.

## Not verified yet

The MySQL connection of the server has not been tested against a live MySQL server (the store itself runs against MySQL 8.4 in Vector's own tests). PostgreSQL and SQLite are tested against real databases.
