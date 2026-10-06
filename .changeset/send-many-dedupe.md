---
"@sweberdev/vector": minor
---

New `vector.sendMany(inputs)` sends up to 1000 events at once, validated first and with one endpoint lookup per tenant. New receiver helpers `memoryDeduper`, `once` and, in the database entries, `postgresDeduper`, `sqliteDeduper` and `mysqlDeduper` remember handled `webhook-id`s so repeated deliveries are skipped.
