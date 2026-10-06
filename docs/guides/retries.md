---
title: Retries and failures
description: The retry schedule, what counts as a failure, automatic disabling of endpoints, and how to retry or resend.
---

## The schedule

A delivery gets up to eight attempts: one right away and seven retries after

| Retry | Wait |
|---|---|
| 1 | 5 seconds |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | 5 hours |
| 6 | 10 hours |
| 7 | 10 hours |

That is about 27 hours in total, enough to ride out a long outage on the receiving side. Each wait varies by ±10 % so that many failed deliveries do not all come back at the same moment. If the endpoint answers `429` or `503` with a `Retry-After` header, Vector waits at least that long (at most 24 hours).

Change the schedule with `retrySchedule`, a list of seconds; its length plus one is the number of attempts:

```ts
createVector({ retrySchedule: [10, 60, 600] }); // four attempts over about 11 minutes
```

## What counts as a failure

Success is any 2xx status. Everything else is a failure:

- other statuses, including 3xx: Vector does not follow redirects, because a redirect could point into your internal network
- network errors and TLS errors
- no answer within `timeoutMs` (15 seconds by default)
- a URL that is no longer allowed, for example because its host name now resolves to a private address

Each attempt is stored with status code, error, duration and the first 2 KiB of the response body (`maxResponseBytes`).

## When a delivery gives up

After the last attempt the delivery's status becomes `failed` and the `delivery.failed` event fires. The endpoint's `failureStreak` goes up by one; any successful delivery resets it to zero.

When `failureStreak` reaches `disableEndpointAfter` (default 10), Vector disables the endpoint, sets `disabledReason` and fires `endpoint.disabled`. An endpoint that answers `410 Gone` is disabled at once (`disableOnGone: false` turns that off). Disabled endpoints receive no new deliveries, and their pending deliveries are cancelled. Re-enable with `vector.endpoints.update(id, { enabled: true })`, which also resets the streak.

Tell your customers when this happens; that is what the events are for. [Vector Pro](../pro/overview.md) includes ready-made alerts for Slack, email and webhooks.

## Limiting the rate

A burst of events can overload a customer's server, and a server that answers `429` or times out counts as a failed attempt. To keep the pace gentle, set a limit in requests per second:

```ts
const vector = createVector({
  store,
  rateLimit: 5, // every endpoint
})

// or per endpoint
createVector({ store, rateLimit: (endpoint) => (endpoint.metadata.plan === "free" ? 1 : undefined) })

// or on the endpoint itself
await vector.endpoints.create({ url, metadata: { rateLimit: "2" } })
```

`metadata.rateLimit` wins over the option. A limit of 2 allows a burst of two requests and then one every half second. A delivery over the limit is put back for the moment its turn comes: it is not counted as an attempt, does not use up the retry schedule and does not count towards disabling the endpoint. Test events and manual retries ignore the limit.

The limit is kept in memory. With several worker processes, each one applies it on its own, so the total can be up to the number of processes times the limit.

## Pausing an endpoint

`hold` is asked before every attempt how many seconds deliveries to an endpoint should wait. Return `undefined` to deliver now. Held deliveries stay pending and are not counted as attempts, like deliveries over the rate limit.

```ts
createVector({
  store,
  hold: (endpoint) => (endpoint.metadata.paused === "true" ? 300 : undefined),
})
```

Vector Pro's `vector-ops` uses it for a circuit breaker that stops sending to an endpoint that is down.

## Retry and resend

```ts
await vector.retry(deliveryId);                      // fresh set of attempts, starting now
await vector.resend(messageId);                      // again to every endpoint it went to
await vector.resend(messageId, { endpointId });      // to one endpoint, also a new one
```

Both take `{ tenant }` to scope them to a customer. Retried and resent requests carry the same `webhook-id` as before, so receivers that deduplicate handle them only once. To recover everything that failed during an outage in one go, use `recover` from Vector Pro.
