import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/index.mjs";

const directory = await mkdtemp(
  join(tmpdir(), "compensated-json-store-demo-")
);

const store = new JsonStore(directory);

const show = (label, value) => {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
};

console.log("Compensated JSON Store — Basic Demo");
console.log(`Storage directory: ${directory}`);

try {
  await store.open();

  // --------------------------------------------------
  // 1. CREATE: Initialize the customers collection
  // --------------------------------------------------

  await store.create("customers", "C100", {
    name: "ALICIA",
    status: "ACTIVE",
    balance: 100
  });

  await store.create("customers", "C101", {
    name: "BOB",
    status: "PENDING",
    balance: 50
  });

  await store.create("customers", "C102", {
    name: "CAROL",
    status: "ACTIVE",
    balance: 200
  });

  // --------------------------------------------------
  // 2. LIST: Retrieve all customers
  // --------------------------------------------------

  show("All customers", await store.list("customers"));

  // --------------------------------------------------
  // 3. QUERY: Case-insensitive CONTAINS
  // --------------------------------------------------

  const query1 = await store.query(
    "customers",
    new URLSearchParams("name=ali")
  );

  show("Customers with name containing 'ali'", query1);

  // Repeated fields use OR.
  const query2 = await store.query(
    "customers",
    new URLSearchParams("status=active&status=pending")
  );

  show("Customers with ACTIVE or PENDING status", query2);

  // Different fields use AND.
  const query3 = await store.query(
    "customers",
    new URLSearchParams("name=ali&status=active")
  );

  show("Customers matching name AND status", query3);

  // --------------------------------------------------
  // 4. SET: Change one field
  // --------------------------------------------------

  const rename = await store.set(
    "customers",
    "C100",
    "name",
    "ALICE"
  );

  show("After SET name", await store.get("customers", "C100"));

  // --------------------------------------------------
  // 5. SUBTRACT and ADD: Numeric operations
  // --------------------------------------------------

  const debit = await store.subtract(
    "customers",
    "C100",
    "balance",
    50
  );

  show("After SUBTRACT 50", await store.get("customers", "C100"));

  await store.add(
    "customers",
    "C100",
    "balance",
    25
  );

  show("After ADD 25", await store.get("customers", "C100"));

  // --------------------------------------------------
  // 6. COMPENSATE: Reverse selected operations
  // --------------------------------------------------

  const debitCompensation = await store.compensate(
    debit.operationId
  );

  show("Debit compensation result", debitCompensation);

  const renameCompensation = await store.compensate(
    rename.operationId
  );

  show("Rename compensation result", renameCompensation);

  show(
    "Customer after compensation",
    await store.get("customers", "C100")
  );

  // --------------------------------------------------
  // 7. HISTORY: Operation summaries
  // --------------------------------------------------

  const history = await store.history(
    "customers",
    "C100"
  );

  show("Customer operation history", history);

  // --------------------------------------------------
  // 8. getOperation: Full operation details
  // --------------------------------------------------

  const operation = await store.getOperation(
    debit.operationId
  );

  show("Original debit operation", operation);

  // --------------------------------------------------
  // 9. RESTART: Verify durable persistence
  // --------------------------------------------------

  await store.close();

  const reopened = new JsonStore(directory);
  await reopened.open();

  show(
    "Customer after store restart",
    await reopened.get("customers", "C100")
  );

  show(
    "Debit operation after restart",
    await reopened.getOperation(debit.operationId)
  );

  await reopened.close();

  console.log("\nBasic demo completed successfully.");
  console.log(`Inspect the storage files at: ${directory}`);

} catch (error) {
  console.error("\nDemo failed:");
  console.error(error);
  process.exitCode = 1;
}
