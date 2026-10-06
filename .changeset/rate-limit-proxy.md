---
"@sweberdev/vector": minor
---

New `rateLimit` option: most requests per second to one endpoint, as one number, a function per endpoint, or `metadata.rateLimit` on the endpoint. Deliveries over the limit wait and are not counted as failed attempts. New `dispatcher` option passes an undici dispatcher (for example a `ProxyAgent`) to `fetch`, so deliveries can leave through an egress proxy with a fixed IP.
