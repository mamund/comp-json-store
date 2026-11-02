import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/index.mjs';
import { setFields, compensateFields, PartialSetFieldsError } from '../src/helpers/set-fields.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cjs-helper-test-'));
  const store = new JsonStore(dir);
  try {
    await store.open();
    await store.create('customers', 'C100', { name: 'ALICIA', status: 'ACTIVE' });
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('independent SETs compensate in reverse order', () => fixture(async store => {
  const ops = await setFields(store, 'customers', 'C100', { name: 'ALICE', status: 'PENDING' });
  assert.equal(ops.length, 2);
  assert.notEqual(ops[0].operationId, ops[1].operationId);
  const results = await compensateFields(store, ops);
  assert.deepEqual(results.map(x => x.field), ['status', 'name']);
  assert.ok(results.every(x => x.status === 'SUCCESS'));
  assert.deepEqual(await store.get('customers', 'C100'), { name: 'ALICIA', status: 'ACTIVE' });
}));

test('partial failure preserves operation IDs', () => fixture(async store => {
  let failure;
  try {
    await setFields(store, 'customers', 'C100', { name: 'ALICE', ['__proto__']: 1, status: 'PENDING' });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof PartialSetFieldsError);
  assert.equal(failure.operations.length, 1);
  assert.equal(failure.cause.code, 'INVALID_ARGUMENT');
  assert.equal((await store.get('customers', 'C100')).name, 'ALICE');
  const results = await compensateFields(store, failure.operations);
  assert.equal(results[0].status, 'SUCCESS');
  assert.deepEqual(await store.get('customers', 'C100'), { name: 'ALICIA', status: 'ACTIVE' });
}));

test('rejects invalid fields argument', () => fixture(async store => {
  await assert.rejects(setFields(store, 'customers', 'C100', null), TypeError);
}));
