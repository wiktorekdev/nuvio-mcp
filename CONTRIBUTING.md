# Contributing

Thanks for helping. This is an unofficial community project, not affiliated with or endorsed by
Nuvio.

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

`npm test` builds the server and runs it over stdio and HTTP against an in-memory mock backend
(`test/mock-nuvio.mjs`), so no real Nuvio account is needed.

## Tools

- Register mutations with `defineMutation` / `defineLocalMutation`; they handle dry runs, previews,
  snapshots and audit. Never hardcode `apply: true` in a handler — use `ctx.apply`.
- Read resources through `client.readRpc` / `client.select`.
- Tool argument schemas live in `src/nuvio/schemas.ts`. `nuvio_apply_plan` validates operations with
  the same schemas as the direct tools, so keep them in sync.
- Avoid breaking tool schemas. When replacing a tool, keep a deprecated compatibility alias
  (`canonical: false`, `replacement: '...'`) where practical.
- New behavior needs a test.

## Project layout

```
src/
  index.ts            entrypoint
  config.ts           environment configuration
  mcp.ts              server factory
  server/http.ts      HTTP transport
  nuvio/              auth, client, snapshots, domain operations
  tools/              tool registration
test/                 unit, tool and HTTP tests + mock backend
```

## Pull requests

- Keep changes focused; one concern per pull request.
- Add or update tests for behavior changes.
- Update `README.md` or `SECURITY.md` when user-facing behavior changes.
- Do not commit secrets, tokens or `.env` files.

## Commit messages

Short, imperative subjects, optionally with a prefix (`fix:`, `docs:`, `test:`).
