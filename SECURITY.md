# Security

## Reporting

Open a private security advisory on GitHub
(<https://github.com/wiktorekdev/nuvio-mcp/security/advisories/new>) rather than a public issue.

## Scope

This is an unofficial community project. It is not affiliated with or endorsed by Nuvio. The server
never calls Nuvio's `delete-account` edge function; account deletion is not implemented.

## Secrets in tool output

Provider credentials, tracker tokens, PINs and passwords are masked in every tool result,
`nuvio_inspect_snapshot`, and the audit log. Masking is key-based: values under recognised secret
keys are replaced before output. In addition to the pattern-matched keys, the exact keys `pin`,
`current_pin`, `new_pin`, `old_pin`, `pincode` and `passcode` are always masked, while unrelated
fields such as `pinToTop` and `pin_enabled` are preserved. Sensitive snapshots do intentionally store
the previous raw values locally so credential and tracker changes can be undone to the exact prior
value (see below).

## Data at rest

Everything is written under `NUVIO_DATA_DIR` (default `~/.local/share/nuvio-mcp`):

| Path               | Mode   | Contents                                          |
| ------------------ | ------ | ------------------------------------------------- |
| `session.json`     | `0600` | Nuvio refresh token                               |
| `snapshots/`       | `0700` | Pre-change snapshots                              |
| `snapshots/*.json` | `0600` | Captured state (see below)                        |
| `audit.jsonl`      | `0600` | Applied mutations with masked arguments and diffs |

The audit log is rotated to `audit.jsonl.1` once it exceeds 5 MB.

`.env` files are only read from the package installation directory, never from the current working
directory: running the server inside an untrusted directory cannot repoint the backend or data paths.

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
`nuvio_undo` and `nuvio_redo` honour the same flag and also stop writing snapshots.

## Confirmation tokens

Operations a snapshot cannot reverse use a prepare/execute flow. The first call returns a token that
is an HMAC over the tool name, a SHA-256 hash of a canonical fingerprint of the arguments, an expiry
(5 minutes) and a random nonce. The raw arguments are never embedded in the token, so secrets (for
example a profile PIN) and large backups cannot be read out of it. The second call must present the
same tool and arguments; tokens are single-use (consumed in memory until expiry) and rejected if the
arguments or tool differ. Replay protection is in-process: restarting the server clears the
consumed-nonce set, so within the token's 5-minute TTL a restart can allow a replay. Set
`NUVIO_CONFIRM_SECRET` and treat the server process as trusted.
Applied to `nuvio_delete_profile`, `nuvio_restore_backup`, `nuvio_revoke_session`,
`nuvio_set_profile_pin`, `nuvio_clear_profile_pin` and `nuvio_register_device`.

## Snapshot integrity

When snapshots are enabled, a reversible mutation only runs after its pre-change snapshot is durably
written (temp file, fsync, atomic rename, mode `0600`). If the snapshot cannot be persisted the
mutation is refused. When a
snapshot records the identities a change touched, restore only affects those identities and leaves
unrelated items alone. Snapshots from older versions that predate this do not carry that information
and are restored as a full resource. Snapshot ids are validated before touching the filesystem, so a
crafted id cannot read or delete files outside the snapshot directory.

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
  full-replace write API. Only profile settings use a guarded write and are rejected on conflict;
  other resources have no such protection. After a failed batch write, `nuvio_apply_plan` will not
  roll back a resource that changed after the plan wrote it.
- `nuvio_inspect_addon` fetches a caller-supplied manifest URL. Only `http(s)` and publicly routable
  hosts are allowed: loopback, private, link-local and multicast addresses are refused, every DNS
  answer and every redirect hop is re-checked, and the request has a timeout and a response-size cap.
- Outbound requests to the Nuvio backend and authorization endpoints have a timeout, so a slow or
  malicious endpoint cannot hang a tool call.
- Reads are retried on transient failures; writes are not retried automatically unless the operation
  is explicitly idempotent, since Nuvio's sync endpoints do not deduplicate.
- Anyone with read access to `NUVIO_DATA_DIR` can read the refresh token and any raw secrets held in
  snapshots. Protect the directory (and the Docker volume) accordingly.
