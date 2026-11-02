import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cjs-example-'));
const store = new JsonStore(dir);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

await store.open();
try {

// A pristine CREATE can be compensated by removing its document.
const created = await store.create('items', 'I100', { name: 'Draft' });
show('Compensate untouched CREATE', await store.compensate(created.operationId));
show('After CREATE compensation (null)', await store.get('items', 'I100'));

// A modified document prevents compensation of its original CREATE.
const modifiedCreate = await store.create('items', 'I200', { name: 'Original' });
await store.set('items', 'I200', 'name', 'Revised');
const conflict = await store.compensate(modifiedCreate.operationId);
show('Compensate modified CREATE (CONFLICT)', conflict);
if (conflict.status !== 'CONFLICT') throw new Error('Expected modified CREATE conflict');

// A DELETE can be compensated if the document ID has not been reused.
const removed = await store.delete('items', 'I200');
show('After DELETE', await store.get('items', 'I200'));
const restored = await store.compensate(removed.operationId);
show('Compensate DELETE', restored);
if (restored.status !== 'SUCCESS') throw new Error('Expected DELETE compensation');
show('Restored document', await store.get('items', 'I200'));
show('DELETE operation details', await store.getOperation(removed.operationId));
show('History I100', await store.history('items', 'I100'));
show('History I200', await store.history('items', 'I200'));
} finally {
  await store.close();
}
console.log(`\nJournal and documents: ${dir}`);
