# Compensated JSON Store — v0.1 reliability pass

## Summary

35 automated tests passed, 0 failed, in the current Linux/Node.js environment.

## Changes

- Directory synchronization errors are no longer suppressed. Unsupported sync behavior fails explicitly.
- `get`, `list`, `query` (through `list`), `getOperation`, and `history` wait for pending mutations before reading state.
- Added tests for read visibility, rehashed invalid field names, rehashed invalid compensation inverses, post-restart SET conflicts, and failed recovery followed by successful retry.
- Documented filesystem support, journal integrity boundaries, uncertain mutation outcomes, and recovery behavior.

## Release-candidate assessment

The implementation is ready for an independent application-level evaluation, but not yet validated as a broadly portable or power-loss-durable storage library.

### Completed

- [x] Five compensable mutations: CREATE, DELETE, SET, ADD, SUBTRACT.
- [x] One JSON file per document and per journal operation.
- [x] Authoritative sequenced journal with durable head commit boundary.
- [x] Single-writer serialized mutations and read-after-mutation visibility.
- [x] Idempotent compensation and conflict detection.
- [x] Journal replay and controlled process-exit tests.
- [x] Adversarial replay tests and recovery failure handling.

### Outstanding validation

- [ ] Run tests on each officially supported platform and filesystem.
- [ ] Test disk-full and I/O failures at additional commit boundaries.
- [ ] Validate power-loss durability on target hardware/filesystem.
- [ ] Inspect npm packaging and run independent consumer smoke tests.

## Known limitations

- No cross-process concurrency or distributed locking.
- No caller-supplied idempotency keys: uncertain committed mutation outcomes require application-level reconciliation.
- Coordinated rollback or tampering with both journal and head cannot be detected internally.
- Rebuilding materialized files on startup may become expensive as journal size grows.

## Scope

No changes to GRAIL are required. Collections remain implicitly created on first document creation. No UPDATE, multi-field SET, bulk import, or explicit collection creation API has been added.
