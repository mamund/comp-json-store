import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/index.mjs';
const worker = fileURLToPath(new URL('../scripts/crash-worker.mjs', import.meta.url));
async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cjs-crash-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const s=new JsonStore(root);await s.open();await s.create('accounts','A1',{balance:100});await s.close();
  return root;
}
function run(root,action,point,id) {
  return spawnSync(process.execPath,[worker,root,action,...(id?[id]:[])],{
    env:{...process.env,CJS_FAULT_TEST:'1',CJS_CRASH_AT:point},encoding:'utf8'});
}
for (const [point,committed] of [['before-journal-write',false],['after-journal-commit',true],['before-materialize',true],['after-materialize',true]]) {
  test(`crash ${point}: mutation is ${committed?'committed':'absent'} after restart`,async t=>{
    const root=await setup(t);
    const result=run(root,'subtract',point);
    assert.equal(result.status,86,result.stderr);
    const store=new JsonStore(root);await store.open();
    assert.equal((await store.get('accounts','A1')).balance,committed?50:100);
    assert.equal((await store.history('accounts','A1')).length,committed?2:1);
    await store.close();
  });
}
for (const [point,committed] of [['before-journal-write',false],['after-journal-commit',true],['before-materialize',true],['after-materialize',true]]) {
  test(`crash ${point}: compensation is ${committed?'applied once':'not applied'}`,async t=>{
    const root=await setup(t);
    const s=new JsonStore(root);await s.open();const debit=await s.subtract('accounts','A1','balance',50);await s.close();
    const result=run(root,'compensate',point,debit.operationId);
    assert.equal(result.status,86,result.stderr);
    const recovered=new JsonStore(root);await recovered.open();
    assert.equal((await recovered.get('accounts','A1')).balance,committed?100:50);
    const outcome=await recovered.compensate(debit.operationId);
    assert.equal(outcome.status,committed?'ALREADY_COMPENSATED':'SUCCESS');
    assert.equal((await recovered.get('accounts','A1')).balance,100);
    assert.equal((await recovered.history('accounts','A1')).length,3);
    await recovered.close();
  });
}
test('tampered but syntactically valid journal entry fails integrity check',async t=>{
  const root=await setup(t);
  const journal=path.join(root,'journal');const file=(await fs.readdir(journal))[0];
  const filename=path.join(journal,file);const entry=JSON.parse(await fs.readFile(filename,'utf8'));
  entry.document.balance=900;
  await fs.writeFile(filename,JSON.stringify(entry)+'\n');
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
for (const point of ['after-temp-write','after-temp-sync','after-rename']) {
  test(`crash ${point}: journal recovery is consistent`, async t => {
    const root=await setup(t);
    const result=run(root,'subtract',point);
    assert.equal(result.status,86,result.stderr);
    const recovered=new JsonStore(root);await recovered.open();
    const balance=(await recovered.get('accounts','A1')).balance;
    assert.equal(balance,100);
    assert.equal((await recovered.history('accounts','A1')).length,1);
    await recovered.close();
  });
}
test('missing middle journal operation fails recovery',async t=>{
  const root=await setup(t);
  const s=new JsonStore(root);await s.open();await s.add('accounts','A1','balance',10);await s.add('accounts','A1','balance',5);await s.close();
  const journal=path.join(root,'journal');const files=(await fs.readdir(journal)).filter(x=>x.endsWith('.json')).sort();
  await fs.rm(path.join(journal,files[1]));
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
test('rehashed invalid arithmetic transition fails semantic replay',async t=>{
  const {createHash}=await import('node:crypto');
  const root=await setup(t);
  const s=new JsonStore(root);await s.open();await s.subtract('accounts','A1','balance',10);await s.close();
  const journal=path.join(root,'journal');const file=(await fs.readdir(journal)).filter(x=>x.endsWith('.json')).sort()[1];
  const filename=path.join(journal,file);const entry=JSON.parse(await fs.readFile(filename,'utf8'));
  entry.after=999;delete entry.checksum;
  entry.checksum=createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  await fs.writeFile(filename,JSON.stringify(entry)+'\n');
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});

test('missing final committed operation fails recovery',async t=>{
  const root=await setup(t);
  const s=new JsonStore(root);await s.open();await s.add('accounts','A1','balance',10);await s.close();
  const journal=path.join(root,'journal');
  const files=(await fs.readdir(journal)).filter(f=>f.endsWith('.json')).sort();
  await fs.rm(path.join(journal,files.at(-1)));
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
test('missing head on populated store fails recovery',async t=>{
  const root=await setup(t);await fs.rm(path.join(root,'head.json'));
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
test('tampered head checksum fails recovery',async t=>{
  const root=await setup(t);const file=path.join(root,'head.json');
  const head=JSON.parse(await fs.readFile(file,'utf8'));head.checksum='0'.repeat(64);
  await fs.writeFile(file,JSON.stringify(head));
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
for(const [point,committed] of [['before-head-write',false],['after-journal-commit',true]]) {
  test(`head boundary ${point}: ${committed?'committed':'uncommitted'}`,async t=>{
    const root=await setup(t);const result=run(root,'subtract',point);
    assert.equal(result.status,86,result.stderr);
    const store=new JsonStore(root);await store.open();
    assert.equal((await store.get('accounts','A1')).balance,committed?50:100);
    await store.close();
  });
}
