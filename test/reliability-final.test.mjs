import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JsonStore} from '../src/index.mjs';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cjs-final-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new JsonStore(root);await store.open();
  await store.create('customers','C1',{name:'ALICIA',balance:100});
  return {root,store};
}
async function tamper(root, sequence, change) {
  const journal=path.join(root,'journal');
  const filename=(await fs.readdir(journal)).find(f=>f.startsWith(String(sequence).padStart(12,'0')+'-'));
  const file=path.join(journal,filename);
  const entry=JSON.parse(await fs.readFile(file,'utf8'));
  change(entry);
  delete entry.checksum;
  entry.checksum=createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  await fs.writeFile(file,JSON.stringify(entry)+'\n');
  const headPath=path.join(root,'head.json');
  const head=JSON.parse(await fs.readFile(headPath,'utf8'));
  if(head.sequence===sequence){head.checksum=entry.checksum;await fs.writeFile(headPath,JSON.stringify(head)+'\n');}
}
test('reads wait for an in-flight mutation, including materialization',async t=>{
  const {store}=await setup(t);
  const original=store.materialize.bind(store);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let entered;
  const atMaterialize=new Promise(resolve=>{entered=resolve;});
  store.materialize=async (...args)=>{entered();await gate;return original(...args);};
  const write=store.set('customers','C1','name','ALICE');
  await atMaterialize;
  let settled=false;
  const read=store.get('customers','C1').then(x=>{settled=true;return x;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(settled,false);
  release();await write;
  assert.equal((await read).name,'ALICE');
  await store.close();
});
test('rehashed invalid field name fails replay',async t=>{
  const {root,store}=await setup(t);
  await store.set('customers','C1','name','ALICE');await store.close();
  await tamper(root,2,e=>{e.field='__proto__';});
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
test('rehashed invalid compensation inverse fails replay',async t=>{
  const {root,store}=await setup(t);
  const debit=await store.subtract('customers','C1','balance',10);
  await store.compensate(debit.operationId);await store.close();
  await tamper(root,3,e=>{e.inverse.amount=9;});
  await assert.rejects(new JsonStore(root).open(),{code:'JOURNAL_CORRUPT'});
});
test('SET compensation conflict survives restart',async t=>{
  const {root,store}=await setup(t);
  const first=await store.set('customers','C1','name','ALICE');
  await store.set('customers','C1','name','ALISON');await store.close();
  const reopened=new JsonStore(root);await reopened.open();
  assert.deepEqual(await reopened.compensate(first.operationId),{operationId:first.operationId,status:'CONFLICT',reason:'FIELD_MODIFIED'});
  await reopened.close();
});
test('failed reconstruction keeps store unavailable, retry succeeds after repair',async t=>{
  const {root,store}=await setup(t);await store.close();
  const data=path.join(root,'data');
  await fs.rm(data,{recursive:true,force:true});
  await fs.writeFile(data,'block directory creation');
  const failed=new JsonStore(root);
  await assert.rejects(failed.open());
  await assert.rejects(failed.get('customers','C1'),{code:'STORE_NOT_OPEN'});
  await fs.rm(data);
  const recovered=new JsonStore(root);await recovered.open();
  assert.equal((await recovered.get('customers','C1')).name,'ALICIA');
  await recovered.close();
});
