# Release checklist (package-launch)

| Item | Status |
|---|---|
| Repo `Weber-Development/vector` | created by the Werkbank workflow `new-package` (secret `NPM_TOKEN` set there); public via `go-public` once CI is green |
| npm `@sweberdev/vector` | 0.1.0 via the first changeset. npm provenance needs a public repo: make it public first, then merge the "version packages" PR |
| packages.sweber.dev | entry, docs and live demo at packages.sweber.dev/vector (portfoliov3 PR) |
| Docs | Markdown in `docs/` with `nav.json`; Pro pages under `docs/pro/` |
| Pro | yes: `@weber-development/vector-{portal,catalog,ops}` in `Weber-Development/vector-pro`, customers via `vector-pro-dist` |
| Prices | proposed to Seya 2026-10-05 (decision card in the project thread) |
| Polar | config in Werkbank `packages/vector.json`; benefit "Vector Pro" to be created by Seya |
| Blog post | `content/blog/vector-0-1-0-released.md` in portfoliov3, after 0.1.0 is on npm |
| Trademark check "Vector" | open (Seya) |
