---
title: Event catalog
description: "vector-catalog: typed event definitions with Standard Schema validation, generated reference docs, AsyncAPI 3.0 and TypeScript types."
---

Part of Vector Pro. A typed catalog of the webhook events your application sends, on top of [`@sweberdev/vector`](https://packages.sweber.dev/vector). Validate every payload before it is stored, get compile-time errors for unknown event types and wrong payloads, and generate reference docs, an AsyncAPI 3.0 document and TypeScript types for your receivers from the same definition.

Schemas are any [Standard Schema](https://standardschema.dev) validator: zod 3.24+ or 4, valibot, arktype and others. The package has no runtime dependencies.

```ts
import { defineCatalog } from "@weber-development/vector-catalog";
import { z } from "zod";

export const catalog = defineCatalog({
  "invoice.paid": {
    description: "An invoice was paid in full.",
    schema: z.object({ invoiceId: z.string(), amount: z.number().int() }),
    example: { invoiceId: "inv_123", amount: 4200 },
    // Optional, used for AsyncAPI and the TypeScript output:
    jsonSchema: {
      type: "object",
      required: ["invoiceId", "amount"],
      properties: { invoiceId: { type: "string" }, amount: { type: "integer" } },
    },
    since: "1.2",
  },
  "invoice.voided": {
    description: "An invoice was voided.",
    schema: z.object({ invoiceId: z.string() }),
    example: { invoiceId: "inv_124" },
    deprecated: "Use invoice.cancelled instead.",
  },
});

export default catalog;
```

## Sending

```ts
await catalog.send(vector, "invoice.paid", { invoiceId: "inv_123", amount: 4200 }, { tenant: "acme" });
```

The payload is typed from the schema (its input type) and validated before `vector.send` is called; what is sent is the schema's output, so defaults and transforms apply. An invalid payload throws `CatalogValidationError` with `eventType` and the schema's `issues`; an unknown event type throws a `TypeError`. Nothing is stored in either case. The last argument takes the other `send` options of the free package (`tenant`, `idempotencyKey`, `endpointIds`, `deliverNow`).

`catalog.validate(type, payload)` validates without sending. `catalog.checkExamples()` validates every example against its schema, useful in a test.

## For the portal

```ts
createPortalHandler(vector, { authorize, eventTypes: catalog.eventTypes() });
```

`eventTypes()` returns `{ type, description, deprecated }` for each event; pass `{ includeDeprecated: false }` to hide deprecated ones.

## Docs and types

- `catalog.toMarkdown({ title?, intro? })`: an event reference with a table of contents, deprecation notes and example request bodies.
- `catalog.toAsyncAPI({ title, version, description? })`: an AsyncAPI 3.0 document object with one message per event (the `{ type, timestamp, data }` body, the Standard Webhooks headers and the example).
- `catalog.toTypeScript()`: declarations your customers can copy: one payload type per event (from `jsonSchema`, else `unknown`), `WebhookEventMap`, `WebhookEventType` and the union `WebhookEvent`.

Or from the command line, with a module that exports the catalog as default (or as `catalog`):

```sh
npx vector-catalog dist/catalog.js --format markdown --out docs/webhooks.md
npx vector-catalog dist/catalog.js --format asyncapi --title "Acme webhooks" --version 1.2.0 --out asyncapi.json
npx vector-catalog dist/catalog.js --format ts --out webhook-types.d.ts
npx vector-catalog dist/catalog.js --check   # exit 1 if an example does not match its schema
```

The CLI imports plain JavaScript (`.js` or `.mjs`); point it at your build output.

Licence: see LICENSE.md
