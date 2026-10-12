---
title: Sending webhooks
description: Endpoints, tenants, event type filters, custom headers, idempotency and test events.
---

## Endpoints and tenants

An endpoint is a URL that receives webhooks. Each endpoint belongs to a **tenant**: the customer, workspace or project in your product that owns it. A message sent for a tenant only goes to that tenant's endpoints. If your product has no tenants, leave `tenant` out everywhere; it is then `null`.

```ts
const endpoint = await vector.endpoints.create({
  url: "https://example.com/webhooks",
  tenant: "acme",
  description: "Production",
  eventTypes: ["invoice.*", "customer.created"], // null or left out: all events
  headers: { authorization: "Bearer ..." },     // sent with every request
  metadata: { createdBy: "user_42" },            // for you, never sent
});
```

`create` checks the URL (see [Security](security.md)) and generates a 24-byte secret. Pass `secret` to bring your own, for example when migrating from another provider. Headers that Vector sets itself (`content-type`, `user-agent`, `webhook-*`) cannot be overridden.

Manage endpoints with `vector.endpoints.get`, `list`, `update`, `delete` and `rotateSecret`. The getters and mutators take an optional `{ tenant }` scope: with it, an endpoint of another tenant is treated as missing. Pass it whenever the id comes from a request, so one customer can never touch another customer's endpoint.

```ts
await vector.endpoints.update(id, { enabled: false }, { tenant: session.orgId });
```

## Event types

Event types are dot-separated names such as `invoice.paid` or `customer.subscription.updated`. Endpoint filters can name exact types, a prefix with `.*` (`invoice.*` matches `invoice.paid` and `invoice.line.added`) or `*`.

## Sending

```ts
const { message, deliveries, duplicate } = await vector.send({
  tenant: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "inv_123" },
  idempotencyKey: "inv_123:paid",
});
```

`send` stores the message and one **delivery** per matching, enabled endpoint, then returns. The deliveries are made by `process()` or the background worker; see [Workers](workers.md). With `deliverNow: true` the first attempt happens right away and `send` waits for it.

The payload must be JSON. It becomes `data` in the body `{ type, timestamp, data }`; `timestamp` is when the message was created, so it stays the same on retries. Payloads are limited to 256 KiB by default (`maxPayloadBytes`).

**Idempotency.** With an `idempotencyKey`, a second `send` with the same key for the same tenant returns the first message with `duplicate: true` and sends nothing. Use it when the code that sends may run twice, for example in a job that can be retried.

**Only some endpoints.** `endpointIds` limits a send to those endpoints; they still have to match the tenant and the event type.

## Payload filters

An endpoint can limit itself to messages whose payload matches a condition, on top of its event types:

```ts
await vector.endpoints.create({
  url: "https://example.com/webhooks",
  tenant: "acme",
  eventTypes: ["invoice.*"],
  filter: {
    and: [
      { path: "amount", op: "gte", value: 1000 },
      { path: "customer.country", op: "in", value: ["CH", "DE"] },
    ],
  },
});
```

A condition is `{ path, op, value }`. `path` is dot-separated (`customer.country`). Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists` (`value: true | false`), `prefix` (strings) and `contains` (substring or array element). Combine with `and`, `or` and `not`; nesting is limited to 5 levels and 50 conditions. A missing field never matches, except for `ne`, `nin` and `exists: false`. Invalid filters are rejected when the endpoint is created or updated. Pass `filter: null` to `update` to remove one.

## Ordered delivery

Deliveries are not ordered by default: retries and parallel workers mean a later message can arrive first. When order matters, give related messages the same `orderingKey`, for example an order id:

```ts
await vector.send({ eventType: "order.created", payload, orderingKey: order.id });
await vector.send({ eventType: "order.paid", payload, orderingKey: order.id });
```

For one endpoint and one key, Vector delivers the next message only after the earlier ones have succeeded, failed for good or been cancelled. A message that keeps failing therefore delays later messages with the same key (until its retries run out), but not other keys. `orderingKey` is 1 to 256 characters and cannot be combined with `deliverNow`. Order is by the time of `send`; messages of one key sent in the same millisecond keep their call order.

## Replaying history

`replay` sends stored messages of a time range again, oldest first, as new deliveries, for example after an endpoint was down for a day or a new endpoint needs history. It respects event types and filters, and needs an explicit tenant (`null` for none) so a range never crosses tenants:

```ts
const { messages, deliveries, truncated } = await vector.replay({
  tenant: "acme",
  from: new Date("2026-10-01T00:00:00Z"),
  endpointId: endpoint.id, // optional
  eventTypes: ["invoice.*"], // optional, exact types
  limit: 1000, // default 1000, at most 10000
});
```

`truncated` is `true` when more messages matched than `limit`; call again with a later `from`. Replayed deliveries keep the original `webhook-id` (the message id), so a receiver that ignores repeated ids will skip them. Receivers that deduplicate must let replays through, for example by clearing the ids of the range first.

## Sending many events

After an import or a nightly job, use `sendMany` instead of a loop:

```ts
const results = await vector.sendMany(
  invoices.map((invoice) => ({
    eventType: "invoice.created",
    payload: invoice,
    tenant: invoice.accountId,
    idempotencyKey: `invoice-created-${invoice.id}`,
  })),
)
```

It takes up to 1000 events per call, checks all of them before storing anything, reads the endpoints of each tenant once and returns the results in the order of the inputs. Repeats of an idempotency key inside the batch are recognised as duplicates. It is not one transaction: if the database fails midway, the first events are already stored, so give every event an `idempotencyKey` and repeat the call.

## Changing the body per endpoint

Not every receiver wants the `{ type, timestamp, data }` envelope. A Slack channel wants blocks, a partner wants only three fields. The `transform` option of `createVector` runs before every attempt and can replace the body, add headers or skip the delivery:

```ts
const vector = createVector({
  store,
  transform: ({ message, endpoint, body }) => {
    if (endpoint.metadata.format === "slack") {
      return { body: { text: `${message.eventType} happened` } };
    }
    if (message.eventType.startsWith("debug.")) return { skip: "Debug events are not delivered" };
    return undefined; // keep the default body
  },
});
```

- Return `{ body }` with any JSON value to send that instead. The new body is signed like any other.
- Return `{ headers }` to add headers for this delivery. Vector's own headers (`content-type`, `user-agent`, `webhook-*`) cannot be overridden.
- Return `{ skip: "reason" }` to not deliver this message to this endpoint. The delivery is cancelled and the reason is kept in `lastError`.
- If the function throws, the attempt counts as failed with the error `Transform failed: ...` and is retried like any other failure, so a fixed template delivers the event later.

Keep the function fast and free of side effects: it runs again for every retry. Vector Pro's `vector-transform` brings ready-made Slack, Microsoft Teams, Discord and Google Chat formats on top of this hook.

## Test events

```ts
const delivery = await vector.sendTest(endpointId, { tenant: "acme" });
```

sends a `webhook.test` event to one endpoint right away, ignoring its event type filter and even if it is disabled, and returns the delivery with the result. This is what a "Send test event" button in your settings page needs.

## Reading the log

```ts
await vector.messages.list({ tenant: "acme", eventType: "invoice.paid", limit: 20 });
await vector.deliveries.list({ messageId, status: "failed" });
await vector.attempts.list({ deliveryId });
```

Lists are newest first. Page backwards with `before: lastItem.createdAt` (`at` for attempts).

## Events

```ts
vector.on("delivery.failed", async ({ delivery, endpoint, message }) => {
  await notifyCustomer(endpoint.tenant, `Webhook to ${endpoint.url} failed`);
});
```

| Event | When |
|---|---|
| `attempt` | After every HTTP request, successful or not |
| `delivery.succeeded` | A delivery got a 2xx answer |
| `delivery.failed` | All attempts are used up, or the endpoint answered `410 Gone` |
| `endpoint.disabled` | Vector switched an endpoint off |

Errors thrown by listeners go to the `onError` option and never stop a delivery.
