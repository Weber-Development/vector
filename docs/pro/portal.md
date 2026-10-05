---
title: Customer portal
description: "vector-portal: a tenant-scoped webhook API and React components your customers use to manage endpoints and read their delivery log."
---

Part of Vector Pro. An embeddable webhook portal for your customers, on top of [`@sweberdev/vector`](https://packages.sweber.dev/vector): they add and edit their endpoints, reveal and rotate signing secrets, send test events, and browse the message log with every attempt, status code and response body. Retry and resend are one click away.

Three layers, use what you need:

- **Server** (`@weber-development/vector-portal`): `createPortalHandler(vector, options)` returns a Fetch-API handler `(request: Request) => Promise<Response>` for Next.js route handlers, Hono, Bun, Deno or Workers. `toNodeHandler` adapts it to Node `http` and Express.
- **Client** (`@weber-development/vector-portal/client`): `createPortalClient(apiBase, { fetch?, headers? })`, a typed client for the API.
- **React** (`@weber-development/vector-portal/react`): `<WebhookPortal />` plus `EndpointList`, `EndpointForm`, `EndpointDetail` and `MessageLog`. Styles in `@weber-development/vector-portal/styles.css`.

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
| `GET /messages` | Message log with delivery status (`eventType`, `before`, `limit` up to 100) |
| `GET /messages/:id` | One message with deliveries and attempts |
| `POST /messages/:id/resend` | Send again; optional `{ endpointId }` |
| `POST /deliveries/:id/retry` | Queue a delivery again |
| `GET /event-types` | The `eventTypes` option (array or function) |
| `GET /stats` | Per-endpoint attempts and success rate over the last 24 hours |

Lists page backwards: pass the `next` value of a response as `before`.

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

`WebhookPortal` takes `apiBase` or a ready `client`, plus optional `fetch`, `headers` (an object or a function, e.g. for a bearer token), `title` and `className`. The bundle is marked `"use client"`. React 18 or 19 is an optional peer dependency; the server and the client work without it.

The single components take a `client` from `createPortalClient` and callbacks such as `onSelect`, `onSaved`, `onDeleted` and `onBack`, so you can place them in your own layout.

### Theming

All colours, radii and fonts are CSS custom properties on `.vector-portal`, for example:

```css
.vector-portal {
  --vector-accent: #0f766e;
  --vector-radius: 4px;
  --vector-font: "Inter", sans-serif;
}
```

Light and dark follow `prefers-color-scheme`. Force one with `data-theme="light"` or `data-theme="dark"` on a parent element.

Licence: see LICENSE.md
