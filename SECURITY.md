# Security

## Reporting

Open a private security advisory on GitHub
(<https://github.com/wiktorekdev/nuvio-mcp/security/advisories/new>) rather than a public issue.

## Scope

This is an unofficial community project. It is not affiliated with or endorsed by Nuvio. The server
never calls Nuvio's `delete-account` edge function; account deletion is not implemented.

## Secrets in tool output

Provider credentials, tracker tokens, PINs and passwords are masked in every tool result,
`nuvio_inspect_snapshot`, and the audit log. Masking is key-based: raw secrets never appear in MCP
outputs or audit entries. Sensitive snapshots do intentionally store the previous raw values locally
so credential and tracker changes can be undone to the exact prior value (see below).

## Data at rest

Everything is written under `NUVIO_DATA_DIR` (default `~/.local/share/nuvio-mcp`):

| Path               | Mode   | Contents                                          |
| ------------------ | ------ | ------------------------------------------------- |
| `session.json`     | `0600` | Nuvio refresh token                               |
| `snapshots/`       | `0700` | Pre-change snapshots                              |
| `snapshots/*.json` | `0600` | Captured state (see below)                        |
| `audit.jsonl`      | `0600` | Applied mutations with masked arguments and diffs |

**Sensitive snapshots contain raw secrets.** To make credential and tracker changes exactly
reversible, snapshots for `provider_credentials`, `tracker_tokens` and `profile_setup` store the
previous raw values (an earlier API key or OAuth token) on disk. This is deliberate: without it a
credential change could not be undone to the exact prior value. If your threat model does not allow
local plaintext secrets, purge `snapshots/` after sensitive operations, or do not use the server to
manage credentials.

Set `NUVIO_CONFIRM_SECRET` to a stable random value (32+ characters) in multi-instance deployments.
Without it, each process uses a random secret and confirmation tokens are only valid on the process
that issued them.

Set `NUVIO_DISABLE_SNAPSHOTS=true` to never write snapshots to disk. Reversible changes then run
without undo and no raw credentials are stored locally, but the server can no longer revert them.

## Confirmation tokens

Operations a snapshot cannot reverse use a prepare/execute flow. The first call returns a token that
is an HMAC over the tool name, a canonical fingerprint of the arguments, an expiry (5 minutes) and a
random nonce. The second call must present the same tool and arguments; tokens are single-use
(consumed in memory until expiry) and rejected if the arguments or tool differ. Replay protection is
in-process: restarting the server clears the consumed-nonce set, so within the token's 5-minute TTL a
restart can allow a replay. Set `NUVIO_CONFIRM_SECRET` and treat the server process as trusted.
Applied to `nuvio_delete_profile`, `nuvio_restore_backup`, `nuvio_revoke_session`,
`nuvio_set_profile_pin`, `nuvio_clear_profile_pin` and `nuvio_register_device`.

## Snapshot integrity

A reversible mutation only runs after its pre-change snapshot is durably written (temp file, fsync,
atomic rename, mode `0600`). If the snapshot cannot be persisted the mutation is refused. Restore is
scope-precise: it deletes only the identities the mutation touched and never removes unrelated items,
even when the backend paginates.

## Remote HTTP

- The endpoint is stateless Streamable HTTP at `POST /mcp`; `GET /health` reports status.
- `Host` and `Origin` are validated before the MCP handler runs (DNS-rebinding protection). For a
  public hostname set `NUVIO_HTTP_ALLOWED_HOSTS`.
- Authentication is a static bearer token (`NUVIO_HTTP_TOKEN`, compared in constant time) or RFC 7662
  token introspection (`NUVIO_OAUTH_INTROSPECTION_URL`, optional client credentials and required
  scopes). When `NUVIO_OAUTH_ISSUER` is set, RFC 9728 protected-resource metadata is served at
  `/.well-known/oauth-protected-resource`.
- A non-loopback bind refuses to start without authentication unless
  `NUVIO_HTTP_ALLOW_UNAUTHENTICATED=true` is set explicitly.
- Limits: request bodies are capped at `NUVIO_HTTP_MAX_BODY_BYTES` for every request (including
  `Transfer-Encoding: chunked`, which returns 413 beyond the limit); `NUVIO_HTTP_MAX_CONCURRENCY`
  returns 503 beyond the cap; `NUVIO_HTTP_REQUEST_TIMEOUT_MS` sets the socket timeout; CORS is
  disabled unless `NUVIO_HTTP_CORS` is set.

## Threat-model notes

- Concurrent mutations to the same profile are last-writer-wins, which is inherent to Nuvio's
  full-replace write API. Settings writes use the backend's guarded RPC and are rejected on conflict.
- Writes are never retried automatically, since Nuvio's sync endpoints are not idempotent.
- Anyone with read access to `NUVIO_DATA_DIR` can read the refresh token and any raw secrets held in
  snapshots. Protect the directory (and the Docker volume) accordingly.
