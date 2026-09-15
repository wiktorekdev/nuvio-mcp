<div align="center">

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/nuviomcp-wordmark-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/nuviomcp-wordmark-light.png" />
    <img src="assets/nuviomcp-wordmark-light.png" alt="Nuvio MCP" width="400" />
  </picture>

  <p>
    <strong>An unofficial MCP server for managing your Nuvio account from AI clients.</strong><br />
    Profiles · Addons · Plugins · Settings · Collections · Library · Providers · Trackers
  </p>

  <p>
    <a href="https://github.com/wiktorekdev/nuvio-mcp/actions/workflows/ci.yml"><img src="https://github.com/wiktorekdev/nuvio-mcp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://www.npmjs.com/package/nuvio-mcp"><img src="https://img.shields.io/npm/v/nuvio-mcp?style=flat&color=6366f1&logo=npm&logoColor=white" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/nuvio-mcp"><img src="https://img.shields.io/npm/dm/nuvio-mcp?style=flat&color=6366f1&logo=npm&logoColor=white" alt="npm downloads" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-6366f1?style=flat" alt="MCP" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat&logo=node.js&logoColor=white" alt="Node" />
    <a href="LICENSE"><img src="https://img.shields.io/github/license/wiktorekdev/nuvio-mcp?style=flat&color=6366f1&cacheSeconds=3600" alt="License" /></a>
  </p>

  <p>
    <em>Unofficial community project. Not affiliated with or endorsed by Nuvio.</em>
  </p>

</div>

---

## Features

- Manage profiles, addons and plugins
- Update TV, mobile and desktop settings
- Manage collections, library, watch progress and history
- Manage provider credentials and trackers
- Export backups
- Undo and redo reversible changes
- Two-step confirmation for irreversible operations
- stdio and remote Streamable HTTP

`nuvio_capabilities` lists every tool at runtime.

## Installation

Add it to your MCP clients with [add-mcp](https://add-mcp.com):

```bash
npx add-mcp nuvio-mcp -g \
  --env "NUVIO_EMAIL=you@example.com" \
  --env "NUVIO_PASSWORD=your-password"
```

Run the server directly over stdio:

```bash
npx -y nuvio-mcp
```

From source:

```bash
git clone https://github.com/wiktorekdev/nuvio-mcp
cd nuvio-mcp
npm ci
npm run build
cp .env.example .env
node dist/index.js
```

## Configuration

| Variable                         | Description                         |
| -------------------------------- | ----------------------------------- |
| `NUVIO_EMAIL`                    | Nuvio account email                 |
| `NUVIO_PASSWORD`                 | Nuvio account password              |
| `NUVIO_REFRESH_TOKEN`            | Alternative to email/password       |
| `NUVIO_BACKEND_TIMEOUT_MS`       | Backend request timeout (ms)        |
| `NUVIO_TRANSPORT`                | `stdio` (default) or `http`         |
| `NUVIO_HTTP_TOKEN`               | Bearer token for the HTTP endpoint  |
| `NUVIO_SNAPSHOT_MAX_AGE_DAYS`    | Snapshot retention: max age (days)  |
| `NUVIO_SNAPSHOT_MAX_COUNT`       | Snapshot retention: max count       |
| `NUVIO_SNAPSHOT_MAX_TOTAL_BYTES` | Snapshot retention: max total bytes |

See [`.env.example`](.env.example) for all options.

## Remote MCP

```bash
NUVIO_TRANSPORT=http \
NUVIO_HTTP_HOST=0.0.0.0 \
NUVIO_HTTP_PORT=3333 \
NUVIO_HTTP_TOKEN="$(openssl rand -hex 32)" \
npx -y nuvio-mcp
```

- Streamable HTTP endpoint: `POST /mcp`
- Health: `GET /health`
- Bearer token, or OAuth introspection when configured
- A non-loopback bind requires authentication

Docker:

```bash
docker build -t nuvio-mcp .
docker run --rm -p 3333:3333 \
  -e NUVIO_EMAIL=you@example.com \
  -e NUVIO_PASSWORD=your-password \
  -e NUVIO_HTTP_TOKEN=change-me \
  -v nuvio-mcp-data:/data \
  nuvio-mcp
```

## Tools: canonical vs deprecated

`nuvio_capabilities` returns the **canonical** tool list (65 tools) plus a separate
`deprecated_tools` list. Deprecated aliases stay callable for compatibility but are hidden from
capabilities and marked `[DEPRECATED]` with their replacement in the tool description.

| Deprecated alias                                   | Canonical replacement                     |
| -------------------------------------------------- | ----------------------------------------- |
| `nuvio_set_setting` / `nuvio_unset_setting`        | `nuvio_update_settings` (`set` / `unset`) |
| `nuvio_set_home_catalog_path`                      | `nuvio_update_home_catalog_settings`      |
| `nuvio_toggle_addon`                               | `nuvio_update_addon`                      |
| `nuvio_toggle_plugin`                              | `nuvio_update_plugin`                     |
| `nuvio_copy_settings` / `nuvio_copy_profile_setup` | `nuvio_copy_setup`                        |
| `nuvio_mark_watched`                               | `nuvio_add_to_watch_history`              |

## dry_run

Every mutation accepts `dry_run: true`: it validates, reads and computes the exact diff, but
**writes nothing, creates no snapshot and writes no audit entry**.

`nuvio_update_settings` takes `patch` (deep-merged), `set` (nested dot paths) and `unset` (delete
paths), applied in that order. Arrays and scalars replace; nested objects merge; `null` is a value;
deletion happens only via `unset`.

## nuvio_apply_plan

Apply many canonical operations as one transaction:

1. validates every operation against the **exact same Zod schema** as its direct tool (types,
   defaults, enums, URL rules, refinements and required fields), plus the same handler-level
   validation (`url` or `id` required, supported providers). Deprecated aliases are rejected. The
   whole plan is rejected up front if any operation is invalid, unsupported or irreversible — before
   any write;
2. reads each affected resource **once**, computes all changes in memory, then writes each resource
   **once**. Settings use the same guarded write as the direct tool, so optimistic concurrency is
   preserved: a plan never overwrites a settings change made after the plan read;
3. takes a single **composite snapshot** whose **per-resource scope** records exactly which keys
   (library / watch-progress / watch-history) were touched, so `nuvio_undo` can restore the precise
   pre-plan state;
4. on failure, rolls back and reports an explicit status: `preview`, `applied`, `rolled_back`,
   `partially_applied` or `failed_before_apply` (with per-operation and per-resource diffs).
   `failed_before_apply` is used **only** when no backend write was attempted; once a write starts,
   the result is conservative and never claims nothing was written. A guarded-write conflict is
   reported without blindly overwriting the newer concurrent state.

```jsonc
{
  "operations": [
    {
      "tool": "nuvio_update_settings",
      "args": { "profile_id": 1, "platform": "tv", "set": [{ "path": "features.x", "value": 1 }] },
    },
    { "tool": "nuvio_add_addon", "args": { "profile_id": 1, "url": "https://example.com/manifest.json" } },
  ],
  "dry_run": true,
}
```

## Retry safety

- Reads (GET, and read RPCs, including backup export) retry network errors and
  `408/429/500/502/503/504` with exponential backoff, bounded jitter and `Retry-After`.
- Non-idempotent writes are **never** retried automatically — a lost response must not silently
  double-apply a mutation. Retry only happens for operations that are **intrinsically** idempotent.
- An `Idempotency-Key` is informational only: the hosted backend does not deduplicate, so a key
  never makes a write retryable by itself.
- A `401` triggers one transparent token refresh, then one retry.

### Concurrency

Optimistic concurrency is enforced where the backend supports it: **profile settings** (and the
settings written by `nuvio_copy_setup`) use the guarded write with `expected_updated_at`. Other
resources (home catalog, addons, plugins, collections, library, watch progress/history) are
last-write-wins because there is no guarded RPC. On failure, `nuvio_apply_plan` will **not** roll
back a resource that changed after the plan wrote it — it reports a partial result instead of
clobbering the newer change.

### Backup scope

`nuvio_export_backup` with no scope returns a full backup. When you pass `scope`, `profile_ids` or
`platforms`, the backend must confirm the narrowing; the result then includes `scope_verified` and,
if scoping cannot be confirmed, an explicit `warning`. There is **no silent fallback** that treats a
full backup as scoped.

## Safety

- Reversible mutations create a snapshot before they run
- Undo and redo via `nuvio_undo` and `nuvio_redo` (single and composite snapshots)
- Irreversible operations use two-step confirmation
- Secrets are masked from MCP outputs
- Sensitive snapshots may contain raw credentials locally, for exact undo

Set `NUVIO_DISABLE_SNAPSHOTS=true` to never write snapshots locally: reversible changes then run
without snapshots and cannot be undone, and no raw credentials are stored on disk.

### Copying setup

`nuvio_copy_setup` supports cross-platform mappings, including on the same profile:

```jsonc
{
  "source_profile_id": 1,
  "target_profile_id": 1,
  "platforms": [{ "from": "tv", "to": "mobile" }],
  "settings_mode": "merge",
  "provider_credentials": "none",
}
```

All source states are read before any write, so chained mappings (`tv -> mobile`, then
`mobile -> desktop`) use the original source values. An identity mapping on the same profile is a
no-op. The deprecated `nuvio_copy_settings` delegates to a single `from_platform -> to_platform`
mapping with `settings_mode: replace`.

## Snapshot retention

Snapshots are garbage-collected automatically after every write, and on demand via
`nuvio_prune_snapshots`. That tool previews unless you pass `confirm: true`; `dry_run: true` always
previews (even with `confirm`). The three limits below are independent (age, count, total size); the
newest snapshot is always kept, and an explicit `keep_last` only guards a manual prune. Limits:

| Variable                         | Default    | Meaning                                         |
| -------------------------------- | ---------- | ----------------------------------------------- |
| `NUVIO_SNAPSHOT_MAX_AGE_DAYS`    | `30`       | Remove snapshots older than this (`0` disables) |
| `NUVIO_SNAPSHOT_MAX_COUNT`       | `250`      | Keep at most this many snapshots                |
| `NUVIO_SNAPSHOT_MAX_TOTAL_BYTES` | `52428800` | Keep the directory under ~50 MB                 |

See [SECURITY.md](SECURITY.md) for the security model.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
bash test/docker-smoke.sh
```

## License

[MIT](LICENSE)
