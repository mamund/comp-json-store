import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cjs-example-'));
const store = new JsonStore(dir);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

await store.open();
try {

await store.create('customers', 'C100', { status: 'ACTIVE', region: 'EAST' });
const status = await store.set('customers', 'C100', 'status', 'PENDING');
const region = await store.set('customers', 'C100', 'region', 'WEST');
show('Before compensation', await store.get('customers', 'C100'));
const result = await store.compensate(status.operationId);
show('Compensate status only', result);
if (result.status !== 'SUCCESS') throw new Error('Expected successful compensation');
show('After compensation (region remains WEST)', await store.get('customers', 'C100'));
show('Region operation details', await store.getOperation(region.operationId));
show('History', await store.history('customers', 'C100'));
} finally {
  await store.close();
}
console.log(`\nJournal and documents: ${dir}`);
