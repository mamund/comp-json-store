# Compensated JSON Store: additional examples

These examples use the existing `JsonStore` API. Each creates a fresh temporary
store and prints its directory so you can inspect the journal and documents.
Run from the repository root:

```sh
node examples/basic-demo.mjs
node examples/set-fields-demo.mjs
node examples/compensation-conflict.mjs
node examples/independent-fields.mjs
node examples/numeric-compensation.mjs
node examples/document-lifecycle.mjs
node examples/partial-workflow.mjs
```

| Example | What to observe |
| --- | --- |
| `basic-demo.mjs` | Basic mutations, queries, history, and reopening a store. |
| `set-fields-demo.mjs` | Multiple independent SETs, partial failure, and compensation. |
| `compensation-conflict.mjs` | Compensating an earlier SET after a later SET to the same field returns `CONFLICT`. |
| `independent-fields.mjs` | Compensating `status` leaves a later `region` change intact. |
| `numeric-compensation.mjs` | Reversing SUBTRACT 25 after ADD 10 leaves balance 110 from an initial 100. |
| `document-lifecycle.mjs` | Compensating an untouched CREATE succeeds; a modified CREATE conflicts; DELETE can be compensated when the ID remains available. |
| `partial-workflow.mjs` | An application records operation IDs and compensates completed work in reverse order after a simulated failure. |

## Important semantics

- Every mutation commits separately. Compensation does **not** provide atomicity.
- A compensation is a new journaled operation; the original remains in history.
- Compensation can return `CONFLICT`, and an attempted compensation can also throw.
- Inspect each result. A workflow may require manual intervention.
- `history(collection, id)` shows summaries; `getOperation(operationId)` shows details.
- The workflow example illustrates application coordination, not a transactional
  guarantee or a domain-specific business reversal.

No changes to the storage engine are needed.
