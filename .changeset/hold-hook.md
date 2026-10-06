---
"@sweberdev/vector": minor
---

New `hold` option: asked before every attempt how many seconds deliveries to an endpoint should wait. Held deliveries stay pending and are not counted as attempts. It is the building block for circuit breakers and pauses.
