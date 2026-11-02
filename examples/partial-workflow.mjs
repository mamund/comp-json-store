import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cjs-example-'));
const store = new JsonStore(dir);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

await store.open();
try {

// A local demonstration of application-managed recovery.
// Inventory and customer changes are committed independently.
await store.create('inventory', 'SKU1', { available: 10 });
await store.create('customers', 'C100', { credit: 100 });
const completed = [];
try {
  const order = await store.create('orders', 'O100', { customerId: 'C100', sku: 'SKU1', quantity: 2 });
  completed.push({ collection: 'orders', id: 'O100', operationId: order.operationId });

  const stock = await store.subtract('inventory', 'SKU1', 'available', 2);
  completed.push({ collection: 'inventory', id: 'SKU1', operationId: stock.operationId });

  const charge = await store.subtract('customers', 'C100', 'credit', 30);
  completed.push({ collection: 'customers', id: 'C100', operationId: charge.operationId });

  show('State before simulated failure', {
    order: await store.get('orders', 'O100'),
    inventory: await store.get('inventory', 'SKU1'),
    customer: await store.get('customers', 'C100')
  });

  throw new Error('Simulated shipping service failure');
} catch (error) {
  show('Workflow failure', { message: error.message });
  const results = [];
  for (const step of [...completed].reverse()) {
    try {
      results.push({ ...step, result: await store.compensate(step.operationId) });
    } catch (compensationError) {
      results.push({ ...step, error: compensationError.message });
    }
  }
  show('Reverse-order compensation results', results);
  if (results.some(x => x.error || x.result.status !== 'SUCCESS')) {
    console.warn('Some compensations require manual review');
  }
}
show('State after compensation', {
  order: await store.get('orders', 'O100'),
  inventory: await store.get('inventory', 'SKU1'),
  customer: await store.get('customers', 'C100')
});
for (const [collection, id] of [['orders','O100'], ['inventory','SKU1'], ['customers','C100']]) {
  show(`History ${collection}/${id}`, await store.history(collection, id));
}
} finally {
  await store.close();
}
console.log(`\nJournal and documents: ${dir}`);
