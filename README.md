# Compensated JSON Store

A standalone, dependency-free Node.js JSON document store with a committed
operation journal and explicit compensation. **v0.1 stable release.**

Requires Node.js 20+ and a local filesystem. Tested on Linux. Use **one
`JsonStore` instance in one Node.js process per storage directory**. This
restriction is not enforced by a lock; sharing a directory with another writer
can corrupt data. Network filesystems, power-loss durability, and other
operating systems have not been verified. Not recommended for critical
production data without further validation.

## Install

After publication:

```sh
npm install @mamund/comp-json-store
```

Before publication, test with `npm pack` and install the resulting tarball.

## Quick start

```js
import { JsonStore } from '@mamund/comp-json-store';

const store = new JsonStore('./local-store');
await store.open();
try {
  await store.create('accounts', 'A100', { balance: 100, status: 'ACTIVE' });
  const debit = await store.subtract('accounts', 'A100', 'balance', 25);
  console.log(await store.get('accounts', 'A100')); // balance 75
  const result = await store.compensate(debit.operationId);
  console.log(result); // inspect status, including conflicts
} finally {
  await store.close();
}
```

For source-checkout examples, run `node examples/basic-demo.mjs`. See
[examples/README.md](examples/README.md) for the complete example index.

## API

`new JsonStore(directory)` creates an instance. `await store.open()` opens
and replays committed journal entries; `await store.close()` waits for queued
operations and closes the instance. Create a **new instance** to reopen.

| Method | Behavior |
| --- | --- |
| `create(collection, id, document)` | Create a JSON document; implicit collection creation |
| `get(collection, id)` | Return document or `null` |
| `list(collection)` | Return `{ id, document }` entries |
| `query(collection, params)` | Filter with `URLSearchParams` |
| `set(collection, id, field, value)` | Replace one top-level field |
| `add(collection, id, field, amount)` | Add a positive safe integer |
| `subtract(collection, id, field, amount)` | Subtract a positive safe integer |
| `delete(collection, id)` | Delete a document |
| `compensate(operationId)` | Attempt an independently committed inverse |
| `history(collection, id)` | Return journal operation summaries |
| `getOperation(operationId)` | Return complete operation details or `null` |

Mutations return an object with `operationId`. Collection names and document
IDs use letters, digits, `_`, and `-` (1–128 characters). `SET` can write a
JSON value to one top-level field. Arithmetic requires safe integers and
positive safe-integer amounts; negative resulting balances are allowed.

Queries match top-level scalar fields with **case-insensitive substring**
matching. Repeated keys use OR; distinct keys use AND. For example:

```js
await store.query('customers', new URLSearchParams('name=ali&status=active'));
```

## Multi-field convenience helpers

```js
import {
  setFields, compensateFields, PartialSetFieldsError
} from '@mamund/comp-json-store/helpers/set-fields';

let operations;
try {
  operations = await setFields(store, 'customers', 'C100', {
    name: 'ALICE',
    status: 'PENDING'
  });
} catch (error) {
  if (!(error instanceof PartialSetFieldsError)) throw error;
  // A failed call may have committed earlier fields.
  console.error('Partial update:', error.cause);
  const outcomes = await compensateFields(store, error.operations);
  console.log(outcomes); // inspect every outcome; reversal is not guaranteed
}
```

`setFields()` executes independent SETs in object-entry order and returns
`{field, operationId}` entries. A failed SET throws `PartialSetFieldsError`
with `cause` and `operations` (possibly empty). `compensateFields()` attempts
inverse operations in reverse order and returns all outcomes, including
failures. **Neither helper provides atomic multi-field updates.**

## Compensation semantics

- `SET` restores the prior field value only if the field has not been
  subsequently modified.
- `ADD` and `SUBTRACT` use inverse arithmetic, preserving intervening numeric
  changes if the result remains valid.
- `CREATE` compensates by deleting an unchanged document.
- `DELETE` compensates by recreating a document if its ID remains available.
- `compensate()` returns statuses including `SUCCESS`, `CONFLICT`,
  `ALREADY_COMPENSATED`, and `NOT_FOUND`. Inspect the result and any `reason`.
- Compensation may fail, can be observed separately, and creates a **new
  journal entry**. It does **not** imply atomicity across operations.
- Application code coordinates business-level recovery and handles conflicts.

Storage errors use `StoreError` with a `code` and `details`. A failed commit
may have an uncertain outcome if the caller loses the response after the
journal-head commit. There are no caller-supplied idempotency keys in v0.1.

## Persistence and limitations

The authoritative record consists of immutable numbered JSON files under
`journal/` and the committed high-water mark in `head.json`. Materialized
documents live in `data/<collection>/<id>.json` and are rebuilt on startup.
Journal checksums detect accidental corruption but do not authenticate against
malicious modification or coordinated rollback.

The journal head is the commit boundary. Files are synchronized and renamed
atomically within the same filesystem; directory synchronization is required.
Controlled process-crash tests cover selected write boundaries. These tests do
**not** establish power-loss durability, disk-full behavior, or portability to
other filesystems. The current journal format is incompatible with early
prototype journals; use a fresh directory or an explicit migration.

For local development:

```sh
npm test
npm run test:consumer
```

## Release status

This is the `@mamund/comp-json-store` v0.1 stable release, licensed under MIT.
See `CHANGELOG.md` for release notes and the [GitHub repository](https://github.com/mamund/comp-json-store) for source and issues.
