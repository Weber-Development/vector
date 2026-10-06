---
"@sweberdev/vector": minor
---

New `transform` option: change the body of a delivery per endpoint (other formats, fewer fields), add headers or skip the delivery. A throwing transform fails the attempt and is retried. Types `TransformFunction`, `TransformContext` and `TransformResult` are exported.
