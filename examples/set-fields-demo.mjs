import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';
import { setFields, compensateFields, PartialSetFieldsError } from '../src/helpers/set-fields.mjs';

const directory = await mkdtemp(join(tmpdir(), 'cjs-set-fields-'));
const store = new JsonStore(directory);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

try {
  await store.open();
  await store.create('customers', 'C100', {
    name: 'ALICIA', status: 'ACTIVE', region: 'EAST', balance: 100
  });
  show('Original', await store.get('customers', 'C100'));

  const operations = await setFields(store, 'customers', 'C100', {
    name: 'ALICE', status: 'PENDING', region: 'WEST'
  });
  show('Operation IDs', operations);
  show('Updated', await store.get('customers', 'C100'));
  show('Compensations', await compensateFields(store, operations));
  show('Restored', await store.get('customers', 'C100'));

  // A later SET fails; earlier successful operation IDs remain available.
  try {
    await setFields(store, 'customers', 'C100', {
      name: 'AMY', ['__proto__']: 'ignored', status: 'SUSPENDED'
    });
  } catch (error) {
    if (!(error instanceof PartialSetFieldsError)) throw error;
    show('Partial failure', { operations: error.operations, cause: error.cause.message });
    show('Compensating partial changes', await compensateFields(store, error.operations));
  }
  show('Final customer', await store.get('customers', 'C100'));
  show('History summaries', await store.history('customers', 'C100'));
  console.log(`\nStorage directory: ${directory}`);
} finally {
  await store.close();
}
