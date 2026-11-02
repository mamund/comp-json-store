import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cjs-example-'));
const store = new JsonStore(dir);
const show = (label, value) => console.log(`\n${label}:`, JSON.stringify(value, null, 2));

await store.open();
try {

await store.create('accounts', 'A100', { balance: 100 });
const debit = await store.subtract('accounts', 'A100', 'balance', 25);
const credit = await store.add('accounts', 'A100', 'balance', 10);
show('Balance before compensation (85)', await store.get('accounts', 'A100'));
const result = await store.compensate(debit.operationId);
show('Debit compensation', result);
if (result.status !== 'SUCCESS') throw new Error('Expected successful compensation');
const account = await store.get('accounts', 'A100');
show('Balance after compensation (110)', account);
if (account.balance !== 110) throw new Error('Unexpected balance');
show('Credit operation details', await store.getOperation(credit.operationId));
show('History', await store.history('accounts', 'A100'));
} finally {
  await store.close();
}
console.log(`\nJournal and documents: ${dir}`);
