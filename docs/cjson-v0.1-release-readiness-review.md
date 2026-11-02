# Compensated JSON Store — v0.1 release-readiness review

Review date: 2026-11-02. Source: uploaded `cjson-store.zip`.

## Verification

- `node --test test/*.test.mjs`: **38 passed, 0 failed** (Linux environment).
- All seven `examples/*.mjs` completed with exit code 0.
- `npm pack --dry-run --json` completed, but the package is not configured for publication.
- No code changes were made to the uploaded repository.

## Release blockers

1. **Package publication configuration:** `package.json` declares `private: true` and version `0.1.0-dev`. Choose the final package name and version; remove `private`, add appropriate `exports` and/or `main`, `files`, `license`, and package metadata. The current archive has no LICENSE file. Verify a clean consumer install/import from the generated tarball.
2. **Supported environment and concurrency policy:** implementation assumes a single store instance in one process on a local filesystem, without enforcement. For v0.1 either explicitly constrain deployment and warn users prominently, or implement an ownership guard. Confirm intended supported platforms; current verification was on Linux only.

## Release improvements

1. **Update README:** opening text still describes early prototype and says crash/fault-injection work remains outstanding, contradicting later sections and the present 38-test suite. Replace accumulated progress notes with a current API/semantics/limitations reference.
2. **Document helpers:** include `setFields`, `compensateFields`, `PartialSetFieldsError`, and their direct import path. Explain partial success, error.operations, and that compensation outcomes must be inspected.
3. **Example index:** examples/README.md covers five new demos but omits `basic-demo.mjs` and `set-fields-demo.mjs`.
4. **Consumer and fault tests:** add an installed-package smoke test, and test injected disk-full/permission/I/O failures around head publication and materialization. Clarify that controlled process termination does not prove power-loss durability.
5. **Release files:** add CHANGELOG and LICENSE; decide whether internal review docs, tests, and scripts belong in the npm tarball.

## Deferred after v0.1

- Multi-process writers and cross-process locking.
- Power-loss durability claims across additional operating systems/filesystems.
- Caller-supplied mutation idempotency keys.
- Journal compaction and faster startup for long histories.
- Atomic multi-field/document transactions, automatic rollback policies, and remote storage.

## Design semantics to retain

- Five compensable mutations: CREATE, DELETE, SET, ADD, SUBTRACT.
- SET/ADD/SUBTRACT operate on one top-level field; CREATE/DELETE on document existence.
- Compensation is independently journaled, may conflict or fail, and does not imply atomicity.
- `setFields()` is a convenience coordinator; a partial failure exposes committed operation IDs.
- Journal and `head.json` are authoritative; materialized document files are reconstructed on startup.

## Assessment

**Conditional release candidate.** Existing tests and examples pass. The implementation is suitable for a carefully scoped v0.1 release once packaging, documentation, and supported-environment claims are resolved. This review is not a security audit or a power-loss durability certification.
