# Contributing

Thanks for taking the time to contribute. This is an unofficial community project and is not
affiliated with or endorsed by Nuvio.

## Requirements

- Node.js 20+

## Setup

```bash
git clone https://github.com/wiktorekdev/nuvio-mcp
cd nuvio-mcp
npm ci
npm run build
```

Credentials for local runs go in `.env` (see `.env.example`); never commit them.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
bash test/docker-smoke.sh   # optional, needs Docker
```

`npm test` builds the server and exercises it over stdio and HTTP against an in-memory mock backend
(`test/mock-nuvio.mjs`), so no real Nuvio account is needed.

## Adding or changing a tool

- Register mutations with `defineMutation` / `defineLocalMutation` so they get `dry_run`, previews,
  snapshots, audit and the per-call read cache automatically. Never hardcode `apply: true` in a
  handler — use `ctx.apply`.
- Read resources through `client.readRpc` / `client.select` (cached per call). A mutation must not
  read the same resource twice.
- Keep the canonical tool surface stable: `test/tools.test.mjs` asserts exactly **65 canonical
  tools** and that none of the deprecated aliases appear in `nuvio_capabilities`. When a tool
  changes shape, add a deprecated alias (`canonical: false, replacement: '...'`) instead of removing
  it, and update that contract test with a comment explaining the change.
- New behavior needs a regression test; prefer asserting backend request counts via `mock.stats()`
  for pipeline guarantees.

## Project layout

```
src/
  index.ts            transport entrypoint
  config.ts           environment configuration
  mcp.ts              server factory
  server/http.ts      Streamable HTTP transport
  nuvio/              auth, client, snapshots, domain operations
  tools/              MCP tool registration
test/                 unit, tool and HTTP tests + mock backend
```

## Pull requests

- Keep changes focused; one concern per pull request.
- Add or update tests for behavior changes.
- Update `README.md` or `SECURITY.md` when user-facing behavior or safety guarantees change.
- Do not commit secrets, tokens or `.env` files.

## Commit messages

Use short, imperative subjects, optionally with a conventional prefix (`fix:`, `docs:`, `test:`).
