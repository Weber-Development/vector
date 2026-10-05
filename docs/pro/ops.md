---
title: Operations
description: "vector-ops: alerts, bulk recovery, health reports, Prometheus metrics and data retention."
---

Part of Vector Pro. Operations for [`@sweberdev/vector`](https://packages.sweber.dev/vector) in production: alerts when deliveries fail, bulk recovery after an outage, health reports, Prometheus metrics and data retention for the Postgres store.

## Alerts

```ts
import { createAlerts, emailNotifier, slackNotifier, webhookNotifier } from "@weber-development/vector-ops";

const alerts = createAlerts(vector, {
  notify: [
    slackNotifier(process.env.SLACK_WEBHOOK_URL!),
    emailNotifier((mail) => transporter.sendMail(mail), { to: "ops@example.com", from: "alerts@example.com" }),
    webhookNotifier("https://incidents.example.com/hooks", process.env.ALERT_SECRET!),
  ],
  throttleMinutes: 60,
  onFailureRate: { threshold: 0.5, windowMinutes: 15, minAttempts: 20 },
  dashboardUrl: (endpoint) => `https://admin.example.com/webhooks/${endpoint.id}`,
});
```

Alerts fire when a delivery gives up (`delivery.failed`), when Vector disables an endpoint (`endpoint.disabled`) and, with `onFailureRate`, when too many attempts to an endpoint fail within a sliding window. At most one alert per endpoint and kind goes out within `throttleMinutes`; the next one says how many were held back. Each alert carries the endpoint URL, tenant, event type, reason, last error and your dashboard link, plus a ready English `title` and `text`.

Notifiers run in the background and never slow down delivery. A failing notifier goes to `onError` and does not stop the others. `alerts.flush()` waits for running notifications, `alerts.stop()` unsubscribes. Alerts come from the process that delivers, so create them where the worker runs.

- `slackNotifier(url)`: Slack incoming webhook with blocks and an "Open dashboard" button.
- `emailNotifier(send, { to?, from?, subjectPrefix? })`: builds `{ subject, text, to, from }` for your mail transport.
- `webhookNotifier(url, secret)`: a Standard Webhooks signed `POST` with `{ type: "vector.alert.<kind>", timestamp, data: alert }`. Verify it with `verify` from `@sweberdev/vector`.
- Any function `(alert) => void | Promise<void>` works as a notifier.

## Recovery

```ts
import { recover, reenableAndRecover } from "@weber-development/vector-ops";

// What would be retried?
await recover(vector, { since: new Date("2026-10-05T08:00Z"), until: new Date("2026-10-05T10:00Z"), dryRun: true });
// Queue them again with a fresh set of attempts.
await recover(vector, { since, until, tenant: "acme", eventType: "invoice.paid" });
// The customer fixed their server:
await reenableAndRecover(vector, endpointId, { since });
```

`recover` re-queues failed deliveries created in the window (filters: `tenant`, `endpointId`, `eventType`, `statuses`, `limit`) through `vector.retry` and returns `{ matched, requeued, byEndpoint, deliveryIds, truncated }`. `reenableAndRecover` enables the endpoint, resets its failure streak and queues its failed and cancelled deliveries. Delivery then happens in your worker.

## Health and metrics

```ts
import { createMetricsCollector, healthReport, prometheusMetrics } from "@weber-development/vector-ops";

const report = await healthReport(vector, { since: new Date(Date.now() - 86_400_000) });
// report.endpoints[i]: attempts, successRate, p50Ms, p95Ms, lastSuccessAt, lastError,
// failureStreak, status ("healthy" | "degraded" | "failing" | "disabled" | "idle")
// report.totals: attempts, successRate, p50Ms, p95Ms, pendingDeliveries, byStatus
```

For Prometheus, either read a window from the store on each scrape:

```ts
app.get("/metrics", async (_req, res) => {
  res.type("text/plain; version=0.0.4").send(await prometheusMetrics(vector, { since: new Date(Date.now() - 5 * 60_000) }));
});
```

or count live in the worker process with `createMetricsCollector(vector)` and serve `collector.metrics()`: counters `vector_attempts_total`, `vector_deliveries_completed_total`, `vector_endpoints_disabled_total` and the histogram `vector_attempt_duration_seconds`. Both use the labels `endpoint` (id) and `tenant`.

## Retention (Postgres)

```ts
import { postgresRetention } from "@weber-development/vector-ops";

const result = await postgresRetention({ query: (text, params) => pool.query(text, params) }, { olderThanDays: 30 });
// { attempts, deliveries, messages, cutoff }
```

Deletes attempts older than the cutoff, finished deliveries created before it and messages without deliveries left, in batches (`batchSize`, default 5000). Pending deliveries and their messages are kept; endpoints are never touched. Use the same `query` and `tablePrefix` as `createPostgresStore`, try `dryRun: true` first, and run it from a daily cron job.

Licence: see LICENSE.md
