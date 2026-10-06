---
title: Customer portal
description: "vector-portal: a tenant-scoped webhook API and React components your customers use to manage endpoints, search their delivery log and read the event catalog."
---

Part of Vector Pro. An embeddable webhook portal for your customers, on top of [`@sweberdev/vector`](https://packages.sweber.dev/vector): they add and edit their endpoints, reveal and rotate signing secrets, send test events, search the message log with every attempt, status code and response body, and read the event catalog with examples and schemas. Retry and resend are one click away.

Three layers, use what you need:

- **Server** (`@weber-development/vector-portal`): `createPortalHandler(vector, options)` returns a Fetch-API handler `(request: Request) => Promise<Response>` for Next.js route handlers, Hono, Bun, Deno or Workers. `toNodeHandler` adapts it to Node `http` and Express.
- **Client** (`@weber-development/vector-portal/client`): `createPortalClient(apiBase, { fetch?, headers? })`, a typed client for the API.
- **React** (`@weber-development/vector-portal/react`): `<WebhookPortal />` plus `EndpointList`, `EndpointForm`, `EndpointDetail`, `MessageLog` and `EventCatalog`. Styles in `@weber-development/vector-portal/styles.css`.

## Server

```ts
// app/api/webhooks/[...path]/route.ts (Next.js App Router)
import { createPortalHandler } from "@weber-development/vector-portal";
import { vector } from "@/lib/vector";
import { getSession } from "@/lib/auth";

const handler = createPortalHandler(vector, {
  basePath: "/api/webhooks",
  // Return the tenant of the signed-in customer, or null for 401.
  authorize: async (request) => {
    const session = await getSession(request);
    return session ? { tenant: session.organizationId } : null;
  },
  eventTypes: [
    { type: "invoice.paid", description: "An invoice was paid." },
    { type: "invoice.created" },
  ],
});

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
```

Every route is scoped to the tenant that `authorize` returns. Ids of other tenants answer 404, the tenant is never taken from the request body, and list and detail responses never contain the signing secret. Invalid input (including URLs that Vector's SSRF guard refuses) answers 400 with a message; unexpected errors answer 500 without details and go to `onError`. Responses are sent with `cache-control: no-store`.

| Route | |
|---|---|
| `GET /endpoints` · `POST /endpoints` | List, create (`url`, `description`, `eventTypes`, `headers`, `enabled`) |
| `GET` · `PATCH` · `DELETE /endpoints/:id` | Read, update, delete |
| `GET /endpoints/:id/secret` | The signing secret (and the previous one during a rotation) |
| `POST /endpoints/:id/rotate-secret` | New secret; optional `{ graceSeconds }` |
| `POST /endpoints/:id/test` | Sends a `webhook.test` event now; optional `{ payload }` |
| `GET /endpoints/:id/attempts` | Recent attempts (`limit`, `before`) |
| `GET /messages` | Message log with delivery status. Filters: `eventType` (exact or a pattern such as `invoice.*`), `status`, `endpointId`, `since`, `q` (a message id, or text in the event type or payload); paging with `before` and `limit` up to 100 |
| `GET /messages/:id` | One message with deliveries and attempts |
| `POST /messages/:id/resend` | Send again; optional `{ endpointId }` |
| `POST /deliveries/:id/retry` | Queue a delivery again |
| `GET /event-types` | The `eventTypes` option (array or function) |
| `GET /stats` | Per-endpoint attempts and success rate over the last 24 hours |

Lists page backwards: pass the `next` value of a response as `before`.

Exact event types and `since` are filtered by the store. Text, status, endpoint and wildcard filters are applied in the handler, page by page. One request reads at most `searchScanLimit` messages (default 500) and then answers with what it found and a `next` cursor, so a search over a long history can return a short or empty page that continues with `next`. A message id in `q` is looked up directly.

With Node `http` or Express:

```ts
import { createPortalHandler, toNodeHandler } from "@weber-development/vector-portal";

app.use("/api/webhooks", toNodeHandler(createPortalHandler(vector, { basePath: "/api/webhooks", authorize })));
```

The portal API only changes data. Deliveries still need a worker: `vector.start()` or `vector.process()` from the free package.

## React

```tsx
import { WebhookPortal } from "@weber-development/vector-portal/react";
import "@weber-development/vector-portal/styles.css";

export default function WebhooksPage() {
  return <WebhookPortal apiBase="/api/webhooks" />;
}
```

`WebhookPortal` takes `apiBase` or a ready `client`, plus optional `fetch`, `headers` (an object or a function, e.g. for a bearer token), `title`, `className`, `colorScheme`, `theme`, `catalog` and `envelope`. The bundle is marked `"use client"`. React 18 or 19 is an optional peer dependency; the server and the client work without it.

The single components take a `client` from `createPortalClient` and callbacks such as `onSelect`, `onSaved`, `onDeleted` and `onBack`, so you can place them in your own layout.

### Event catalog

The "Event catalog" tab lists the event types from the `eventTypes` option, grouped by the part before the first dot (or `group`), searchable, with description, `since`, deprecation note, an example request body and the JSON Schema. It appears as soon as the handler lists at least one event type; `catalog={false}` hides it. With `@weber-development/vector-catalog` pass `eventTypes: () => catalog.eventTypes()` and everything is filled from your definitions. Set `envelope={false}` when your Vector instance sends the bare payload.

### Theming

All colours, radii and fonts are CSS custom properties on `.vector-portal`, for example:

```css
.vector-portal {
  --vector-accent: #0f766e;
  --vector-radius: 4px;
  --vector-font: "Inter", sans-serif;
}
```

Light and dark follow `prefers-color-scheme`. Force one with `colorScheme="light"` or `colorScheme="dark"`, or with `data-theme="light"` / `data-theme="dark"` on a parent element.

With shadcn/ui on Tailwind 4, `theme="shadcn"` takes colours, radius and font from its CSS variables (`--background`, `--primary`, `--border`, `--radius`, …) and follows its `.dark` class, so the portal looks like the rest of your app. With Tailwind 3 (HSL triplets) set the `--vector-*` properties yourself, e.g. `--vector-bg: hsl(var(--background))`.
