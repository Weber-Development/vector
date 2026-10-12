---
"@sweberdev/vector": major
---

Vector 2.0: ordered delivery per key (`orderingKey`), payload filters on endpoints (`filter`), `vector.replay()` and `vector.prune()`, a versioned database schema (`store.schemaVersion()`, `SCHEMA_VERSION`) and Node.js 22 as the minimum. Custom stores must implement `deleteMessagesBefore` and `schemaVersion`. Run `store.migrate()` after updating; see `docs/migrating-to-2.md`.
