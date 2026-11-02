import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cjs-example-'));
const store = new JsonStore(dir);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

await store.open();
try {

await store.create('customers', 'C100', { status: 'ACTIVE' });
const first = await store.set('customers', 'C100', 'status', 'PENDING');
const second = await store.set('customers', 'C100', 'status', 'SUSPENDED');
const result = await store.compensate(first.operationId);
show('Earlier SET compensation (expected CONFLICT)', result);
if (result.status !== 'CONFLICT') throw new Error('Expected compensation conflict');
show('Current customer (unchanged by conflict)', await store.get('customers', 'C100'));
show('First operation details', await store.getOperation(first.operationId));
show('Second operation details', await store.getOperation(second.operationId));
show('History', await store.history('customers', 'C100'));
} finally {
  await store.close();
}
console.log(`\nJournal and documents: ${dir}`);
