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
