# Changelog

## 0.1.0 — 2026-11-02

First stable release. No runtime changes from `0.1.0-rc.1`.

## 0.1.0-rc.1 — 2026-11-02

Initial release candidate.

- Local JSON document storage with journal-head commit and restart replay.
- Five compensable mutations: CREATE, DELETE, SET, ADD, SUBTRACT.
- Field-level conflict detection and independently recorded compensation.
- Read-only get, list, query, history, and getOperation APIs.
- `setFields`, `compensateFields`, and `PartialSetFieldsError` helpers.
- Seven runnable examples and controlled process-crash tests.

Known constraints: single writer and store instance per directory, local
filesystem, Node.js 20+, Linux verification only; no power-loss guarantee.
