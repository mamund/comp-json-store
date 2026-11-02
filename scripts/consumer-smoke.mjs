import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const work = await mkdtemp(join(tmpdir(), 'cjson-consumer-'));
try {
  const tarball = execFileSync('npm', ['pack', '--pack-destination', work, '--silent'], {
    cwd: root, encoding: 'utf8'
  }).trim().split('\n').at(-1);
  const consumer = join(work, 'consumer');
  await (await import('node:fs/promises')).mkdir(consumer);
  await (await import('node:fs/promises')).writeFile(join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    join(work, tarball)], { cwd: consumer, stdio: 'pipe' });
  const script = `
    import { JsonStore, StoreError } from '@mamund/comp-json-store';
    import { setFields, compensateFields, PartialSetFieldsError } from '@mamund/comp-json-store/helpers/set-fields';
    import { mkdtemp } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    assert.equal(typeof StoreError, 'function');
    assert.equal(typeof PartialSetFieldsError, 'function');
    const store = new JsonStore(await mkdtemp(join(tmpdir(), 'cjson-installed-')));
    await store.open();
    try {
      await store.create('customers', 'C100', { name: 'ALICIA' });
      const ops = await setFields(store, 'customers', 'C100', { name: 'ALICE' });
      assert.equal((await store.get('customers', 'C100')).name, 'ALICE');
      const outcomes = await compensateFields(store, ops);
      assert.equal(outcomes[0].status, 'SUCCESS');
      assert.equal((await store.get('customers', 'C100')).name, 'ALICIA');
    } finally { await store.close(); }
    console.log('Installed-package consumer smoke test passed');
  `;
  await (await import('node:fs/promises')).writeFile(join(consumer, 'smoke.mjs'), script);
  console.log(execFileSync(process.execPath, ['smoke.mjs'], {
    cwd: consumer, encoding: 'utf8'
  }).trim());
} finally {
  await rm(work, { recursive: true, force: true });
}
