---
title: Migrating from Svix
description: Move from a hosted webhook service to Vector without your customers changing their code.
---

Vector uses the same wire format as Svix (the Standard Webhooks specification), so receivers that verify with the Svix SDKs or a Standard Webhooks library keep working, as long as the secret stays the same.

1. **Export endpoints.** For each Svix application (Vector calls it a tenant) list its endpoints with URL, filters and secret (`GET /api/v1/app/{app_id}/endpoint/{endpoint_id}/secret`).
2. **Create them in Vector with the same secret:**

   ```ts
   await vector.endpoints.create({
     tenant: app.uid,
     url: endpoint.url,
     eventTypes: endpoint.filterTypes ?? null,
     secret: secretFromSvix, // whsec_...
   });
   ```

3. **Switch sending.** Replace `svix.message.create(appId, { eventType, payload })` with `vector.send({ tenant: appId, eventType, payload })`. Svix sends the payload as it is, while Vector wraps it as `{ type, timestamp, data }` by default. To keep the body your customers already parse, create Vector with `envelope: false`.
4. **Headers.** Svix sends `svix-id`, `svix-timestamp` and `svix-signature`; Vector sends `webhook-id`, `webhook-timestamp` and `webhook-signature`. The current Svix SDKs and all Standard Webhooks libraries accept both. Receivers with hand-written verification that only read `svix-*` need the header names changed.
5. **Run both for a day** if you want to be careful: send each event through both systems with the same id, and switch off Svix once nothing fails.

The customer-facing parts of Svix (App Portal, event catalog, operational alerts) are in [Vector Pro](../pro/overview.md).
