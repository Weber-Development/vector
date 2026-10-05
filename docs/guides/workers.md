---
title: Workers and serverless
description: Run deliveries in a long-running process, a cron job, or a queue consumer.
---

`send` only stores the message. Deliveries happen when something calls `process()`.

## Long-running server

```ts
const worker = vector.start({ intervalMs: 1000, concurrency: 10 });

process.on("SIGTERM", async () => {
  await worker.stop(); // finishes the current batch
  process.exit(0);
});
```

The worker picks up to `limit` (default 50) due deliveries, sends them with up to `concurrency` requests in parallel, and immediately looks again if the batch was full; otherwise it waits `intervalMs`. With the PostgreSQL store you can run as many workers as you like.

## Serverless and cron

On Vercel, Netlify or AWS Lambda there is no long-running process. Call `process()` from a scheduled function instead:

```ts
// app/api/cron/webhooks/route.ts, scheduled every minute
export async function GET() {
  const result = await vector.process({ limit: 100 });
  return Response.json(result); // { claimed, succeeded, retrying, failed, cancelled }
}
```

For the first attempt not to wait for the next cron run, send with `deliverNow: true`:

```ts
await vector.send({ tenant, eventType: "invoice.paid", payload, deliverNow: true });
```

Only the first attempt runs inline; retries are picked up by the scheduled `process()`.

## Queues

If you already have a queue (BullMQ, SQS, Inngest, Trigger.dev), call `vector.process()` from a repeating job. Each claimed delivery is locked for `timeoutMs` plus one minute, so a crashed worker's deliveries are picked up again after that.

## In tests

Keep it synchronous: use the default memory store, a fake `fetch` and a fixed `now`, then call `process()` yourself.

```ts
const vector = createVector({
  fetch: async () => new Response(null, { status: 204 }),
  now: () => new Date("2026-10-05T12:00:00Z"),
  urlPolicy: { allowPrivateNetworks: true },
});
```
