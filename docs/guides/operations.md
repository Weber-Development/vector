---
title: Running Vector in production
description: Workers, upgrades, retention, backups, monitoring and what happens when something fails.
---

## Shape of a deployment

Vector is a library, so there are two places it runs: **where you send** (your API, which calls `vector.send` and only stores the message) and **where deliveries happen** (a worker, `vector.start()` in a long-running process, or `vector.process()` from a cron job or queue consumer). They can be the same process or different ones. Both need the same store.

With PostgreSQL, run as many workers as you like; claiming uses `for update skip locked`. With MySQL and SQLite several workers also work (claiming is one statement), but PostgreSQL is the better choice once you run more than one server. The in-memory store is for tests only.

Rate limits (`rateLimit`) and the `hold` callback live in the worker's memory, so with several workers each one applies them on its own. For a hard limit per customer, keep to one worker or choose a limit with that in mind.

## Delivery guarantees

Vector delivers **at least once**. A message is stored before `send` returns. A worker locks the deliveries it picks up for the request timeout plus one minute. If the worker crashes or is killed in between, the lock expires and another worker picks them up again, so a receiver can see the same message twice. Receivers should use the `webhook-id` header to ignore repeats; [Receiving webhooks](receiving.md) shows how.

A failed attempt is retried by the retry schedule (eight attempts over about 27 hours by default). Failures that are not the receiver's fault, such as a rate limit or a `hold`, do not count as attempts.

## Upgrading

1. Read the changelog of the versions you skip. Before 1.0.0, minor versions can contain breaking changes; from 1.0.0 only majors do. See [Stability and versioning](../reference/stability.md).
2. Update the package, then run `await store.migrate()` (or the SQL from the schema function in your own migration tool). It only adds what is missing and is safe on every deploy.
3. Deploy workers and senders in any order. The schema only grows within a major version, so old and new code can share one database during a rolling deploy.
4. Update the Pro packages together; they share one version number and must be at the same version as each other.

## Retention and backups

Every attempt is a row, and a busy system produces many. Delete old messages on a schedule (see [PostgreSQL](postgres.md) and [SQLite and MySQL](sqlite-mysql.md) for the statements), and prune the deduper table daily if you use it. Thirty days is a common choice; keep messages longer if your support team needs to replay them. Vector Pro's `vector-ops` has a retention helper that deletes in batches (PostgreSQL).

Endpoints hold signing secrets, so back up the database like any other secret store and restrict who can read the `vector_endpoints` table. Restoring an old backup does not break receivers: secrets are the same, and messages sent after the backup are simply gone.

## Monitoring

Watch these, in this order of usefulness:

- **Failed deliveries**: listen to `delivery.failed` and `endpoint.disabled` with `vector.on(...)`, and alert on a rising rate. Vector Pro's `vector-ops` summarises this per tenant, and `vector-otel` exports traces and metrics.
- **Backlog**: the number of due, unlocked deliveries. If it grows, add workers or raise `concurrency`. A backlog on a single slow customer is not a capacity problem; use `rateLimit` or `hold` so one endpoint does not occupy every slot.
- **`onError`**: errors in listeners and the worker loop end up here. Send them to your error tracker; the default is `console.error`.

## When things fail

| Situation | What happens |
|---|---|
| The database is down while sending | `send` throws. Decide in your code whether to fail the request or queue the event elsewhere. |
| The database is down in the worker | The loop reports to `onError` and tries again on its next pass. Nothing is lost. |
| A receiver is down | Retries by the schedule. After ten failed deliveries in a row the endpoint is disabled (`disableEndpointAfter`) and you can enable it again. |
| A receiver answers `410 Gone` | The endpoint is disabled (`disableOnGone`). |
| A worker is stopped | `await worker.stop()` finishes the current batch. Anything still locked is picked up after the lock expires. |
| The process is killed | Deliveries in flight are sent again after the lock expires (at least once). |

## Shutting down cleanly

```ts
const worker = vector.start({ concurrency: 10 });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await worker.stop();
    process.exit(0);
  });
}
```

Give the process a grace period of at least the request timeout (15 seconds by default) so in-flight requests can finish.
