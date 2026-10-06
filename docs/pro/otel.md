---
title: OpenTelemetry
description: "vector-otel: spans and metrics for every webhook delivery attempt, for Grafana, Datadog, Honeycomb and any OpenTelemetry backend."
---

Part of Vector Pro. See every webhook delivery attempt of [`@sweberdev/vector`](https://packages.sweber.dev/vector) in the tools you already use for tracing and metrics: Grafana, Datadog, Honeycomb, Jaeger or any OpenTelemetry backend. It needs `@sweberdev/vector` 0.5 or later and has no dependency on the OpenTelemetry SDK.

## Set up

```ts
import { metrics, trace } from "@opentelemetry/api";
import { instrument } from "@weber-development/vector-otel";

instrument(vector, {
  tracer: trace.getTracer("vector"),
  meter: metrics.getMeter("vector"),
});
```

Call it once, in the process that delivers (where `vector.start()` or `vector.process()` runs). It uses whatever OpenTelemetry SDK your app already set up. Pass only the `tracer` or only the `meter` if you want one of them.

## Spans

Every attempt becomes one client span named `vector.deliver`, with the attempt's real start time and duration. Failed attempts have an error status with the reason, such as `HTTP 503` or `Timed out`.

| Attribute | Value |
|---|---|
| `vector.event_type` | The event type, e.g. `invoice.paid` |
| `vector.message.id`, `vector.delivery.id`, `vector.endpoint.id` | Vector's ids, to find the message in the delivery log |
| `vector.attempt` | The number of the attempt, starting at 1 |
| `http.request.method` | `POST` |
| `http.response.status_code` | The status code, when the receiver answered |
| `server.address`, `server.port` | The host and port of the endpoint |

The endpoint URL is **not** recorded by default, because webhook URLs often contain secrets: Slack's and Discord's do. To record it, give `url` a function that returns what to keep, for example the origin only:

```ts
instrument(vector, { tracer, url: (url) => new URL(url).origin });
```

The tenant is not recorded either. `includeTenant: true` adds `vector.tenant` to spans and metrics; think twice if you have many tenants (metric labels with many values get expensive) or if tenant ids are personal data.

## Metrics

| Instrument | Type | Labels |
|---|---|---|
| `vector.attempts` | Counter | `vector.event_type`, `vector.outcome` (`success` or `failure`), `http.response.status_code` |
| `vector.attempt.duration` | Histogram, milliseconds | the same |
| `vector.endpoints.disabled` | Counter | none (`vector.tenant` with `includeTenant`) |

## Options

| Option | Default | |
|---|---|---|
| `tracer` | none | An OpenTelemetry tracer |
| `meter` | none | An OpenTelemetry meter |
| `includeTenant` | `false` | Add `vector.tenant` |
| `url` | none | `(url) => string \| undefined`: adds `url.full` with the returned value |
| `spanName` | `vector.deliver` | |

`instrument` returns `{ stop() }`.

## Licence

Vector Pro licence, see the licence in your Pro download.
