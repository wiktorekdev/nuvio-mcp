# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/).

## [1.1.1] - 2026-09-15

### Fixed

- `NUVIO_SNAPSHOT_MAX_AGE_DAYS`, `NUVIO_SNAPSHOT_MAX_COUNT` and `NUVIO_SNAPSHOT_MAX_TOTAL_BYTES` set to `0`
  now disable the limit instead of reverting to the default.

## [1.1.0] - 2026-09-15

### Added

- Batched mutations via `nuvio_apply_plan`, plus `dry_run` on mutation tools.
- Snapshot retention with `nuvio_prune_snapshots`.
- `nuvio_copy_setup`, `nuvio_update_plugin`, `nuvio_add_to_watch_history`,
  `nuvio_test_provider_credential`.
- Bulk `nuvio_add_to_library` / `nuvio_set_watch_progress` and structured delete keys.

### Changed

- `nuvio_update_settings` now takes `patch` (deep merge), `set` and `unset`.
- Public profile arguments use `profile_id`.
- Deprecated aliases are hidden from `nuvio_capabilities`.

### Fixed

- Unrelated records are no longer overwritten by undo/redo.
- Settings rollback respects optimistic concurrency.
- Deletes are no longer limited to the first page.
- Incomplete reads are refused instead of producing unsound snapshots.
- Retry/backoff only applies to reads and explicitly idempotent writes.

## [1.0.1] - 2026-09-15

### Fixed

- Security hardening and scheme-less addon/plugin URL handling.

## [1.0.0] - 2026-09-15

- Initial release.
