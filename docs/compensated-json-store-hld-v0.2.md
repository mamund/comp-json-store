# Compensated JSON Store

## High-level design — v0.2

**Status:** Proposed design baseline  
**Purpose:** A standalone, file-based JSON document store with built-in operation compensation.

## 1. Goals and boundaries

Provide a small Node.js storage utility that applications can use for ordinary document storage and, when needed, compensation of committed mutations. The initial consumers may include GRAIL demo-world capabilities, but the module has no GRAIL dependency or awareness. Applications and capabilities own orchestration and decide when to request compensation.

Design goals:

- JSON document collections on a local filesystem.
- Simple, predictable storage and query API.
- Exactly one field per value mutation.
- Explicit inverse operations and durable operation identifiers.
- Safe, idempotent compensation with conflict reporting.
- Single-process writer model and crash recovery.
- No external runtime dependencies if practical.

Non-goals for v0.2: SQL, indexing, distributed transactions, network server, cross-process concurrent writers, multi-field mutations, multi-operation atomic transactions, saga coordination, and automatic conflict resolution.

## 2. Architecture

```text
Application / capability
         |
         v
    Public Node API
         |
         v
  Mutation coordinator -------- Query engine
         |                           |
         +-----------+---------------+
                     |
             Document state
                     |
             Persistence layer
              /            \
     JSON collections    JSONL journal
```

The mutation coordinator serializes writes, checks preconditions, records operations, and applies compensation. The persistence layer treats the journal as the recovery authority and collection files as materialized state. Neither the store nor its public API refers to GRAIL concepts.

## 3. Data model

A collection has a name and contains documents addressed by a unique document ID. A document is a JSON object whose fields hold JSON values. IDs belong to the store API and need not appear inside documents.

Illustrative layout:

```text
store/
  data/
    customers.json
    accounts.json
  journal/
    operations.jsonl
  metadata.json
```

Example `customers.json`:

```json
{
  "C100": { "name": "ALICIA", "status": "ACTIVE", "balance": 100 },
  "C101": { "name": "BOB", "status": "PENDING", "balance": 50 }
}
```

Collection names, IDs, and field names must be validated; names must never be interpolated into filesystem paths without safe mapping. The store owns internal revisions and operation metadata.

## 4. Public API

```javascript
const store = new JsonStore('./store');

await store.create('customers', 'C100', { name: 'ALICIA', balance: 100 });
const record = await store.get('customers', 'C100');
const nameChange = await store.set('customers', 'C100', 'name', 'ALICE');
const debit = await store.subtract('customers', 'C100', 'balance', 50);
await store.compensate(debit.operationId);
const matches = await store.query('customers', new URLSearchParams('name=ali'));
```

| Method | Purpose | Scope | Journaled mutation |
|---|---|---|---|
| `create(collection, id, document)` | Create new document | Document | Yes |
| `get(collection, id)` | Retrieve document | Document | No |
| `set(collection, id, field, value)` | Replace one field | Field | Yes |
| `add(collection, id, field, amount)` | Add numeric amount | Field | Yes |
| `subtract(collection, id, field, amount)` | Subtract numeric amount | Field | Yes |
| `delete(collection, id)` | Delete document | Document | Yes |
| `list(collection)` | Return documents | Collection | No |
| `query(collection, params)` | Filter documents | Collection | No |
| `compensate(operationId)` | Apply recorded inverse | Field or document | Yes |
| `getOperation(operationId)` | Full operation detail and current status | Operation | No |
| `history(collection, id)` | Chronological operation summaries | Document | No |

**There is no `update()` method.** Each `set()` call changes exactly one field. Changing three fields requires three calls and produces three independently compensable operations. There is no implicit transaction spanning those calls.

Every successful mutation returns an `operationId`. Reads do not create journal entries.

## 5. Query semantics

Queries mimic HTTP query parameters. A parameter `field=value` means case-insensitive substring **CONTAINS**. Matching preserves original stored casing.

- Different field names combine with AND.
- Repeated values for the same field combine with OR.
- No query parameters return all documents.
- Missing fields do not match.
- No fuzzy matching, regular expressions, or query language in v0.2.

```text
?name=ali
?name=ali&status=active
?status=active&status=pending
?name=ali&status=active&status=pending
```

The last query means `name CONTAINS "ali" AND (status CONTAINS "active" OR status CONTAINS "pending")`. `ali` matches `Alice` and `ALICIA`, but does not match `Sally`.

**Detail to settle before coding:** whether CONTAINS applies only to string fields or stringifies numbers and booleans; and how null, arrays, and nested objects behave. Initial recommendation: query only top-level scalar fields, converting scalar values to strings.

## 6. Compensation model

The operation determines its inverse. The unit of compensation for value mutations is **one field**; document existence operations act on the **whole document**.

| Forward operation | Scope | Inverse | Safety condition |
|---|---|---|---|
| `SET` | One field | Restore prior field value (or absence) | Field has not subsequently changed |
| `ADD` | One numeric field | `SUBTRACT` same amount | Current numeric field valid; inverse allowed |
| `SUBTRACT` | One numeric field | `ADD` same amount | Current numeric field valid; inverse allowed |
| `CREATE` | Whole document | `DELETE` | Document has not subsequently changed |
| `DELETE` | Whole document | `CREATE` from saved snapshot | Document ID has not been reused |

`SET` compensation must restore the distinction between a missing field and a field explicitly set to `null`. For `SET`, field revision checks should detect intervening mutations even if the value later returns to the same text. `ADD` and `SUBTRACT` are relative operations; their inverses preserve later compatible numeric changes. Numeric operations require finite, supported values and explicit overflow/type checks.

Example:

```text
balance 100
A: SUBTRACT 50 -> 50
B: ADD 25      -> 75
compensate A   -> 125
```

For strings:

```text
name ALICIA
A: SET ALICE
B: SET ALISON
compensate A -> CONFLICT (intervening field change)
```

Compensation is a *new, journaled mutation*, referencing its original operation. It never deletes or rewrites the original operation record. Only committed mutations are eligible. Each original operation can be successfully compensated at most once.

## 7. compensate(operationId)

The store performs the following under serialized write coordination:

1. Find the committed original operation.
2. Check whether a committed compensation already exists; if so return `ALREADY_COMPENSATED`.
3. Read the stored inverse and validate current state and conflicts.
4. Commit the inverse as a new operation referencing the original.
5. Return the compensation identifier and outcome.

Example successful response:

```json
{
  "operationId": "op-123",
  "status": "SUCCESS",
  "compensationId": "op-125"
}
```

Possible outcomes: `SUCCESS`, `ALREADY_COMPENSATED`, `CONFLICT`, `NOT_FOUND`, and `FAILED`. A `CONFLICT` leaves state unchanged and reports a reason. A failed or interrupted compensation must be safely retryable without applying the inverse twice.

**Design constraint:** A compensation operation is an audit record of an inverse effect. v0.2 does not define compensation-of-compensation or arbitrary chains of reversals.

## 8. Operation journal and inspection

An append-only JSONL journal records each committed mutation and compensation with unique IDs, timestamps, targets, payloads, inverse information, and commit metadata. An operation detail may look like:

```json
{
  "operationId": "op-123",
  "type": "SUBTRACT",
  "collection": "accounts",
  "documentId": "A100",
  "field": "balance",
  "value": 50,
  "inverse": { "type": "ADD", "value": 50 },
  "status": "COMMITTED",
  "timestamp": "2026-10-31T18:00:00Z"
}
```

`getOperation(operationId)` returns full details and **current derived status**, including compensation reference when present. The original journal entry remains immutable.

`history(collection, id)` returns **summaries only**, in journal order, including both ordinary mutations and compensations. A summary should include operation ID, type, field if applicable, timestamp, status, and `compensates` when relevant. Consumers can request full details through `getOperation()`.

## 9. Persistence and reliability

The store targets one Node.js writer process on a local filesystem. Writes must be serialized within that process; simultaneous writers in separate processes are unsupported initially.

A write-ahead journal with commit/replay rules is required because updating a JSON collection file and a journal file cannot be made atomic together by renaming one file. Collection JSON files are materialized views that can be rebuilt or reconciled from committed journal entries. A mutation is reported successful only after its durable commit point.

Reliability tests must cover:

- Crash before commit, after commit, and during collection-file materialization.
- Restart replay without double-applying ordinary mutations or compensation.
- Repeated compensation requests.
- Conflicting SET, CREATE, and DELETE compensation.
- Compatible intervening numeric operations.
- Invalid types, missing fields, and filesystem failures.

The exact journal record protocol (intent/commit versus committed-operation log plus snapshots), flush sequence, and recovery algorithm are **detailed-design work**. We should not claim crash safety until those tests pass.

## 10. Errors and result contracts

Candidate storage errors include `DOCUMENT_EXISTS`, `DOCUMENT_NOT_FOUND`, `FIELD_NOT_FOUND`, `INVALID_FIELD`, `INVALID_TYPE`, `INVALID_QUERY`, `COMPENSATION_CONFLICT`, and `STORAGE_ERROR`.

Mutating operations return operation IDs on success. Compensation uses explicit outcomes. We will settle whether other failures throw typed errors or return structured error objects before implementation.

## 11. Proposed project structure

```text
compensated-json-store/
  package.json
  README.md
  LICENSE
  src/
    index.mjs
    store.mjs
    documents.mjs
    operations.mjs
    journal.mjs
    compensation.mjs
    query.mjs
  test/
    storage.test.mjs
    query.test.mjs
    compensation.test.mjs
    conflicts.test.mjs
    recovery.test.mjs
  examples/
    basic-storage.mjs
    queries.mjs
    compensation.mjs
```

Use Node.js built-in test tooling. Keep module boundaries flexible until implementation demonstrates a need for separate files.

## 12. Implementation stages

1. **Storage:** Collections, create/get/set/add/subtract/delete/list, validation, and queries.
2. **Journal:** Operation identifiers, committed mutation records, durable replay.
3. **Compensation:** Inverse execution, conflict detection, idempotency, operation inspection, and summary history.
4. **Reliability and adoption:** Crash/restart tests, examples, documentation, then optional use inside GRAIL demo-world capabilities.

## 13. Decisions recorded in v0.2

- Standalone storage module; no GRAIL coupling.
- Only `SET`, `ADD`, `SUBTRACT`, `CREATE`, and `DELETE` are mutating/compensable operations.
- No `UPDATE`; multi-field changes require multiple calls.
- Field-level compensation for value mutations; document-level for existence mutations.
- HTTP-style queries use case-insensitive CONTAINS; AND across distinct fields, OR across repeated fields.
- `history()` returns summaries; `getOperation()` returns full details.
- Compensation is explicit, journaled, idempotent, and conflict-aware.

## 14. Open details for the next design pass

- Query treatment of non-string scalar values, null, and nested structures.
- Whether `SET` may create a previously absent field (recommended: yes, with absence recorded).
- Numeric field creation policy and constraints for `ADD`/`SUBTRACT` (recommended: require existing numeric field).
- Exact journal commit protocol, replay, and snapshot strategy.
- Typed errors versus structured error results for non-compensation calls.
- Whether journal history is retained indefinitely for the initial release (recommended: yes).

The high-level contract is intentionally small. The next work should focus on persistence semantics and executable acceptance tests before broadening the API.
