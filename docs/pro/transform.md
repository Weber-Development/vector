---
title: Chat formats and shaping
description: "vector-transform: send webhooks to Slack, Teams, Discord and Google Chat in their own format, and shape bodies for other receivers."
---

Part of Vector Pro. Send webhooks to Slack, Microsoft Teams, Discord and Google Chat in the format each service expects, with templates per event type, and shape the body for every other receiver. It plugs into the `transform` option of [`@sweberdev/vector`](https://packages.sweber.dev/vector) 0.3 or later.

Chat services do not accept the usual `{ type, timestamp, data }` webhook body. Teams wants an Adaptive Card, Slack wants blocks, Discord wants embeds with hard length limits. Without this package every project writes four formatters, forgets the escaping rules once, and lets a customer's data ping `@channel`.

## Set up

```ts
import { createVector } from "@sweberdev/vector";
import { createTransform } from "@weber-development/vector-transform";

const vector = createVector({
  store,
  transform: createTransform({
    templates: {
      "invoice.paid": {
        title: "Invoice {{ data.id }} paid",
        text: "{{ data.amount | divide:100 | number:2 }} CHF from {{ data.customer.email }}",
        fields: { Plan: "{{ data.plan }}", Customer: "{{ data.customer.name }}" },
        url: "https://admin.example.com/invoices/{{ data.id }}",
      },
    },
  }),
});

await vector.endpoints.create({
  tenant: "acme",
  url: "https://hooks.slack.com/services/T000/B000/XXXX", // detected as Slack
  eventTypes: ["invoice.*"],
});
```

That is all. The endpoint gets a Slack message, because the URL says Slack. Every other endpoint keeps the normal JSON body. Each message is still signed, retried and logged by Vector like any other delivery.

## Which format an endpoint gets

In this order:

1. `formatFor(endpoint)` in the options, if you pass one.
2. `endpoint.metadata.format`: `"slack"`, `"teams"`, `"discord"`, `"googlechat"` or `"raw"` (the normal body).
3. The URL (`detect`, on by default):

| Service | Recognised URL |
|---|---|
| Slack | `hooks.slack.com`; Discord's `.../slack` endpoint |
| Microsoft Teams | Workflows and Power Automate webhooks (`*.logic.azure.com`, `*.powerplatform.com`), `*.webhook.office.com` |
| Discord | `discord.com/api/webhooks/...` |
| Google Chat | `chat.googleapis.com` |

Use `metadata.format` for a proxy or a custom domain. Teams has replaced the old Office 365 connectors with Workflows; create a "Post to a channel when a webhook request is received" workflow and use its URL.

## Writing messages

Without a template a message shows the event type as headline and the first ten values of `data` as label and value pairs, in a colour that follows the event type (`invoice.payment_failed` is red, `invoice.paid` green). A template changes that:

| Field | |
|---|---|
| `title` | The headline. Default: the event type |
| `text` | A paragraph below the headline |
| `fields` | Label and value pairs. A pair whose value is empty is hidden |
| `color` | `good`, `warning`, `danger`, `info` or a hex colour such as `#ff8800` |
| `url` | A link, shown as an "Open" button. Only `http` and `https` are kept |

Templates are chosen by event type: `"invoice.paid"` beats `"invoice.*"` beats `"*"`. Put shared templates in `templates` and per-service ones in `formats: { slack: { templates } }`. A template without `fields` shows none; leave the template out to get the automatic list.

### Template language

`{{ path | filter | filter:argument }}`. The path starts at `data` (the payload), `type`, `id`, `timestamp`, `tenant` or `endpoint`, and goes through objects and arrays: `{{ data.items[0].name }}`. Anything missing gives an empty string. Templates cannot run code or reach anything but the event.

| Filter | |
|---|---|
| `default:"text"` | Use this when the value is missing or empty |
| `upper`, `lower`, `capitalize`, `trim` | Text case and whitespace |
| `truncate:80` | Shorten to 80 characters with an ellipsis |
| `number:2` | Fixed number of decimals |
| `divide:100` | Divide, for amounts in cents |
| `date` | An ISO date or Unix timestamp as `2026-10-06 12:00 UTC` |
| `json` | The value as JSON |

Values inserted into a message are escaped for the target service. In Slack and Google Chat `<`, `>` and `&` are replaced, so `<!channel>` in customer data stays text. Discord messages are sent with `allowed_mentions: { parse: [] }`, so `@everyone` never pings.

## Limits are handled for you

Slack headers and sections, Teams facts, Discord's 256, 1024, 4096 and 6000 character limits and 25 fields, and Google Chat widgets are cut to size with an ellipsis. A long value never makes the service reject the webhook.

## Other endpoints: pick, omit, redact

For receivers that take the normal JSON body, `shapeMetadata(...)` (the endpoint's `metadata.transform`) keeps their data small and free of secrets, without code:

```ts
import { shapeMetadata } from "@weber-development/vector-transform";

await vector.endpoints.create({
  url: "https://partner.example.com/webhooks",
  metadata: shapeMetadata({
    pick: ["id", "customer.email"], // only these paths of data
    omit: ["card"],                 // or remove paths
    redact: ["customer.email"],     // or replace with "[redacted]"
  }),
});
```

Endpoint metadata holds strings, so `shapeMetadata` stores the shape as JSON in `metadata.transform`; you can set that key yourself too.

The stored message is never changed; only what is sent to that endpoint.

## Options

| Option | Default | |
|---|---|---|
| `templates` | none | Templates for all formats, by event type |
| `formats` | all on | `{ slack, teams, discord, googlechat }`: `false` turns a format off, an object sets its `templates` and `maxFields` (default 10, at most 25) |
| `detect` | `true` | Choose the format from the endpoint URL |
| `formatFor` | none | `(endpoint) => "slack" \| "teams" \| "discord" \| "googlechat" \| "raw" \| undefined` |
| `footer` | `Vector · <tenant>` | `(input) => string` for the small line under a message |

`createTransform` returns a plain function, so you can call it yourself in tests or combine it with your own logic:

```ts
const chat = createTransform();
createVector({
  transform: (input) => (input.message.eventType.startsWith("debug.") ? { skip: "debug" } : chat(input)),
});
```

## Licence

Vector Pro licence, see the licence in your Pro download.
