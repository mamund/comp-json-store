import { JsonStore } from '../src/index.mjs';
const [root, action, operationId] = process.argv.slice(2);
const store = new JsonStore(root);
await store.open();
if (action === 'create') await store.create('accounts','A1',{balance:100});
else if (action === 'subtract') await store.subtract('accounts','A1','balance',50);
else if (action === 'compensate') await store.compensate(operationId);
else throw Error('unknown action');
await store.close();
