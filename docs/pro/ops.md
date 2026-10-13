---
title: Operations
description: "vector-ops: alerts, circuit breaker, weekly tenant reports, bulk recovery, health reports, metrics and data retention."
---

Part of Vector Pro. Operations for [`@sweberdev/vector`](https://packages.sweber.dev/vector) in production: alerts when deliveries fail, a circuit breaker for endpoints that are down, weekly reports per tenant, bulk recovery after an outage, health reports, Prometheus metrics and data retention for the Postgres store.

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
// report.totals: attempts, successRate, p50Ms, p95Ms, pendingDeliveries, byStatus, topErrors
```

For Prometheus, either read a window from the store on each scrape:

```ts
app.get("/metrics", async (_req, res) => {
  res.type("text/plain; version=0.0.4").send(await prometheusMetrics(vector, { since: new Date(Date.now() - 5 * 60_000) }));
});
```

or count live in the worker process with `createMetricsCollector(vector)` and serve `collector.metrics()`: counters `vector_attempts_total`, `vector_deliveries_completed_total`, `vector_endpoints_disabled_total` and the histogram `vector_attempt_duration_seconds`. Both use the labels `endpoint` (id) and `tenant`.

## SLO, alert rules and dashboard

```ts
import { grafanaDashboard, prometheusRules, sloStatus } from "@weber-development/vector-ops";

const slo = await sloStatus(vector, {
  since: new Date(Date.now() - 28 * 86_400_000),
  objective: 0.995, // default 0.99
});
// slo.successRate, slo.allowedFailures, slo.budgetRemaining, slo.burnRate, slo.met
// slo.endpoints: the endpoints that miss the objective, worst burn rate first

await writeFile("vector.rules.yml", prometheusRules({ objective: 0.995, labels: { team: "platform" } }));
await writeFile("vector.dashboard.json", grafanaDashboard({ objective: 0.995 }));
```

`sloStatus` counts attempts, not deliveries: a retry that succeeds still used one failed attempt. A burn rate of 1 uses exactly the error budget over the window, 2 uses it twice as fast. `prometheusRules` writes alert rules for a fast burn (14.4 times over one hour and five minutes) and a slow burn (6 times over six hours and 30 minutes), a growing backlog (`backlogThreshold`, default 1000) and a disabled endpoint, for the counters of `createMetricsCollector` and the gauges of `prometheusMetrics`; list the file under `rule_files`. `grafanaDashboard` writes a dashboard with the success ratio against the objective, attempts by outcome, p95 duration, backlog and endpoint tables; import it in Grafana. The files are parsed and checked in tests, but **not yet run through `promtool` or imported into Grafana**. Mutual TLS or a fixed egress IP is a matter of your proxy: pass an undici dispatcher to Vector's `dispatcher` option, see [Security](../guides/security.md).

## Regions and tenant limits

`createDeliveryControls` gives groups of endpoints their own way out to the internet and keeps one tenant from using all of a worker's capacity. It returns the `fetch`, `hold` and `transform` options for `createVector`.

```ts
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { createDeliveryControls } from "@weber-development/vector-ops";

const dispatcher = new ProxyAgent("http://proxy-eu.internal:3128");
const controls = createDeliveryControls({
  fetch: undiciFetch as typeof fetch,
  regions: { eu: { dispatcher }, us: { fetch: sendThroughUsRelay } },
  defaultRegion: "eu",
  tenantRegions: { globex: "us" },
  limits: {
    default: { perSecond: 20, maxConcurrent: 10 },
    tenants: { acme: { perSecond: 100, perDay: 500_000 } },
  },
});

const vector = createVector({ store, ...controls.options });
// Already using a transform (for example from vector-transform)?
// createVector({ store, ...controls.withTransform(myTransform) })
```

**Regions.** An endpoint picks a region with `metadata.region`; if it has none, its tenant's entry in `tenantRegions` applies, then `defaultRegion`. A region sends its requests through its own `dispatcher` (an undici `ProxyAgent`, so the receiver sees the proxy's fixed IP) or its own `fetch`. An endpoint with an unknown region fails its attempt with `Unknown region "…"`, so a typo is visible in the log. `controls.regionOf(endpoint)` tells which region an endpoint uses. A region is an outgoing route: your data stays where your store is.

**Limits.** Per tenant (`default` for tenants without an entry):

- `perSecond` caps the requests of all endpoints of the tenant per second (a burst of `ceil(perSecond)`). Over the limit, deliveries wait and are not counted as attempts.
- `maxConcurrent` caps the requests in flight; further requests wait for a free slot while their timeout runs.
- `perDay` caps the requests per UTC day; deliveries wait until the next day.

Per endpoint, `metadata.rateLimit` (a Vector option already), `metadata.maxConcurrent` and `metadata.dailyLimit` work the same way, as strings. A daily limit counts the deliveries that passed the check, so a delivery that another limit defers right afterwards may use up a slot. Pass `hold: breaker.hold` to combine the limits with a circuit breaker; the longer wait wins. `controls.usage()` returns today's counts per tenant, requests in flight and requests per region, for a dashboard or metrics.

Counters live in the memory of the process. With several worker processes, each one applies the limits on its own.

## Circuit breaker

An endpoint that is down should not eat the retry schedule of every message you send it. The circuit breaker holds deliveries while an endpoint keeps failing and probes it now and then:

```ts
import { createCircuitBreaker } from "@weber-development/vector-ops";

const breaker = createCircuitBreaker({
  failureThreshold: 5,      // failed attempts in a row that open the circuit
  cooldownSeconds: 60,      // hold time; doubles after each failed probe, up to maxCooldownSeconds (900)
  onChange: (change) => console.log(change.to, change.url, change.cooldownSeconds),
});
const vector = createVector({ store, hold: breaker.hold }); // needs @sweberdev/vector 0.5 or later
breaker.attach(vector);                                      // where the worker runs
```

After `failureThreshold` failed attempts in a row the circuit opens and everything for that endpoint waits for the cooldown. Then one delivery goes out as a probe: if the server answers, the circuit closes and the backlog is delivered; if not, the circuit opens again with twice the cooldown. Held deliveries stay pending and are not counted as attempts, so they do not use up the retry schedule and do not count towards disabling the endpoint.

Only failures that say the server is unavailable count: no answer, timeouts, `408`, `429` and `5xx`. A `400` or `404` means the server is up and refused one message; change that with `isFailure`. `onChange` fires on `open`, `half-open` and `closed`, so you can send a message to your team or the customer. `breaker.state(endpointId)` tells the current state and `breaker.reset(endpointId)` closes a circuit by hand.

State lives in memory of the process that delivers. With several workers each one learns on its own, and with high concurrency a few more attempts than the threshold can go out before the circuit opens.

## Weekly reports per tenant

Customers who use your webhooks like to hear that they work, and like to hear early when they do not. `sendTenantReports` builds a report for every tenant and hands you the finished email:

```ts
import { sendTenantReports } from "@weber-development/vector-ops";

await sendTenantReports(vector, {
  since: new Date(Date.now() - 7 * 86_400_000),
  send: async ({ tenant, subject, text, html }) => {
    await transporter.sendMail({ to: await emailOf(tenant), from: "reports@example.com", subject, text, html });
  },
  render: (tenant) => ({ title: tenant, dashboardUrl: `https://app.example.com/${tenant}/webhooks` }),
});
```

Run it from a weekly cron job. Each report shows deliveries attempted, success rate, failed attempts and response times, each compared with the period before, the endpoints that need attention with their last error, and the most frequent errors. Tenants without any attempt in the period are skipped (`includeIdle: true` sends to them too). One tenant failing does not stop the others; `onError` tells which.

For one tenant, `tenantReport(vector, tenant, { since })` returns the numbers and `renderReport(report, options)` the subject, plain text and HTML. The email is yours to send, so wording, language and recipients stay under your control.

## Retention (Postgres)

```ts
import { postgresRetention } from "@weber-development/vector-ops";

const result = await postgresRetention({ query: (text, params) => pool.query(text, params) }, { olderThanDays: 30 });
// { attempts, deliveries, messages, cutoff }
```

Deletes attempts older than the cutoff, finished deliveries created before it and messages without deliveries left, in batches (`batchSize`, default 5000). Pending deliveries and their messages are kept; endpoints are never touched. Use the same `query` and `tablePrefix` as `createPostgresStore`, try `dryRun: true` first, and run it from a daily cron job.

Licence: see LICENSE.md
