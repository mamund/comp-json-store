import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class StoreError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'StoreError'; this.code = code; this.details = details; }
}
const err = (code, message) => { throw new StoreError(code, message); };
const clone = value => structuredClone(value);
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const key = (c, id) => `${c}\u0000${id}`;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const validJson = (v, seen = new Set()) => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || seen.has(v)) return false;
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null && !Array.isArray(v)) return false;
  seen.add(v);
  const ok = Array.isArray(v) ? v.every(x => validJson(x, seen)) : Object.entries(v).every(([k,x]) => !['__proto__','constructor','prototype'].includes(k) && validJson(x, seen));
  seen.delete(v);
  return ok;
};
const number = x => Number.isSafeInteger(x);
const fieldName = x => typeof x === 'string' && x.length > 0 && !['__proto__','constructor','prototype'].includes(x);
const seqFile = (n,id) => `${String(n).padStart(12,'0')}-${id}.json`;
const digest = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// Fault injection is available only in explicit test mode, in a child process.
const crashAt = point => { if (process.env.CJS_FAULT_TEST === '1' && process.env.CJS_CRASH_AT === point) process.exit(86); };

export class JsonStore {
  constructor(root) { this.root = path.resolve(root); this.opened = false; this.closed = false; this.poisoned = false; this.docs = new Map(); this.ops = new Map(); this.entries = []; this.sequence = 0; this.headChecksum = null; this.queue = Promise.resolve(); }
  assertOpen() { if (!this.opened || this.closed || this.poisoned) err('STORE_NOT_OPEN','Store is closed or requires recovery'); }
  names(c,id) { if (!safeName(c) || (id !== undefined && !safeName(id))) err('INVALID_ARGUMENT','Invalid collection or document identifier'); }
  async open() {
    if (this.opened || this.closed) err('INVALID_ARGUMENT','Instance cannot be opened again');
    await fs.mkdir(path.join(this.root,'journal'), {recursive:true});
    await fs.mkdir(path.join(this.root,'data'), {recursive:true});
    const journalDir=path.join(this.root,'journal');
    const headPath=path.join(this.root,'head.json');
    const all=await fs.readdir(journalDir);
    const files=all.filter(x=>x.endsWith('.json')).sort();
    let head;
    try { head=JSON.parse(await fs.readFile(headPath,'utf8')); }
    catch (e) {
      if (e.code==='ENOENT' && files.length===0) {
        head={version:1,sequence:0,checksum:null};
        await this.atomicWrite(headPath,JSON.stringify(head)+'\n');
      } else err('JOURNAL_CORRUPT','Missing or unreadable journal head');
    }
    if (!head || head.version!==1 || !Number.isSafeInteger(head.sequence) || head.sequence<0 ||
        (head.sequence===0 ? head.checksum!==null : !/^[0-9a-f]{64}$/.test(head.checksum)))
      err('JOURNAL_CORRUPT','Invalid journal head');
    // Files above the head are uncommitted orphans. They cannot be replayed.
    // Do not remove them until all committed entries have been validated.
    const committed=files.filter(f=>Number(f.slice(0,12))<=head.sequence);
    if (committed.length!==head.sequence) err('JOURNAL_CORRUPT','Missing committed journal entry');
    let expected = 1;
    for (const file of committed) {
      const m = /^(\d{12})-([0-9a-f-]+)\.json$/.exec(file);
      if (!m || Number(m[1]) !== expected) err('JOURNAL_CORRUPT',`Invalid sequence: ${file}`);
      let entry;
      try { entry = JSON.parse(await fs.readFile(path.join(this.root,'journal',file),'utf8')); } catch { err('JOURNAL_CORRUPT',`Invalid journal JSON: ${file}`); }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validJson(entry) || typeof entry.checksum !== 'string' || entry.checksum !== digest((({checksum,...rest})=>rest)(entry)) || entry.sequence !== expected || entry.operationId !== m[2] || !safeName(entry.collection) || !safeName(entry.documentId) || !['CREATE','DELETE','SET','ADD','SUBTRACT','COMPENSATE'].includes(entry.type) || this.ops.has(entry.operationId)) err('JOURNAL_CORRUPT',`Invalid journal record: ${file}`);
      try { this.apply(entry, true); } catch { err('JOURNAL_CORRUPT',`Unreplayable journal record: ${file}`); }
      this.entries.push(entry); this.ops.set(entry.operationId,entry); this.headChecksum=entry.checksum; this.sequence = expected++;
    }
    if (this.sequence!==head.sequence || this.headChecksum!==head.checksum)
      err('JOURNAL_CORRUPT','Journal head does not match committed tail');
    for (const file of files.slice(committed.length)) await fs.rm(path.join(journalDir,file));
    for (const file of all.filter(f=>f.startsWith('.tmp-'))) await fs.rm(path.join(journalDir,file),{force:true});
    await this.syncDir(journalDir);
    await this.reconcile(); this.opened = true;
  }
  async close() { if (!this.opened || this.closed) return; await this.queue; this.closed = true; }
  serialize(fn) { this.assertOpen(); const p = this.queue.then(()=>{this.assertOpen(); return fn();}); this.queue = p.catch(()=>{}); return p; }
  getDoc(c,id) { return this.docs.get(key(c,id)); }
  validateField(field) { if (!fieldName(field)) err('INVALID_ARGUMENT','Invalid field name'); }
  apply(e, replay=false) {
    if (replay) this.validateReplay(e);
    const k=key(e.collection,e.documentId), state=this.docs.get(k), before=state?.doc;
    if (e.type === 'COMPENSATE') {
      const original=this.ops.get(e.compensates);
      if (!original || original.type === 'COMPENSATE' || original.compensationId) throw Error('Invalid compensation reference');
      const inv=e.inverse;
      if (!inv || !['CREATE','DELETE','SET','ADD','SUBTRACT'].includes(inv.type)) throw Error('Invalid inverse');
      this.apply({...e,...inv,type:inv.type}, false);
      original.compensationId=e.operationId;
      return;
    }
    if (e.type === 'CREATE') { if (state) throw Error('Already exists'); this.docs.set(k,{doc:clone(e.document), revisions:new Map(),generation:e.operationId,changed:false}); return; }
    if (!state) throw Error('Missing document');
    if (e.type === 'DELETE') { this.docs.delete(k); return; }
    if (e.type === 'SET') {
      state.doc[e.field] = clone(e.value);
      if (e.remove) delete state.doc[e.field];
      state.revisions.set(e.field,(state.revisions.get(e.field)||0)+1);
    } else if (e.type === 'ADD' || e.type === 'SUBTRACT') {
      const next=state.doc[e.field]+(e.type==='ADD'?e.amount:-e.amount);
      if (!number(next)) throw Error('Invalid replay arithmetic');
      state.doc[e.field]=next;
      state.revisions.set(e.field,(state.revisions.get(e.field)||0)+1);
    }
    state.changed=true;
  }
  validateReplay(e) {
    const state=this.getDoc(e.collection,e.documentId);
    if (e.type==='CREATE') {
      if (!isObject(e.document) || !validJson(e.document)) throw Error('Invalid CREATE payload');
    } else if (e.type==='DELETE') {
      if (!state || !same(state.doc,e.document)) throw Error('Invalid DELETE snapshot');
    } else if (e.type==='SET') {
      if (!state || !fieldName(e.field) || !validJson(e.value) || typeof e.beforePresent!=='boolean' ||
          e.beforePresent!==Object.hasOwn(state.doc,e.field) ||
          (e.beforePresent && !same(state.doc[e.field],e.before)) ||
          e.fieldRevision!==(state.revisions.get(e.field)||0)+1) throw Error('Invalid SET transition');
    } else if (e.type==='ADD' || e.type==='SUBTRACT') {
      if (!state || !fieldName(e.field) || !number(e.amount) || e.amount<=0 ||
          !number(state.doc[e.field]) || e.before!==state.doc[e.field] ||
          !number(e.after) || e.after!==e.before+(e.type==='ADD'?e.amount:-e.amount)) throw Error('Invalid numeric transition');
    } else if (e.type==='COMPENSATE') {
      const original=this.ops.get(e.compensates);
      if (!original || original.compensationId || original.type==='COMPENSATE' ||
          e.collection!==original.collection || e.documentId!==original.documentId ||
          !e.inverse || !['CREATE','DELETE','SET','ADD','SUBTRACT'].includes(e.inverse.type)) throw Error('Invalid compensation');
      const t=original.type, inv=e.inverse;
      if (t==='CREATE' && (inv.type!=='DELETE' || !state || state.generation!==original.operationId || state.changed)) throw Error('Invalid CREATE inverse');
      if (t==='DELETE' && (inv.type!=='CREATE' || state || !same(inv.document,original.document))) throw Error('Invalid DELETE inverse');
      if (t==='SET' && (!state || inv.type!=='SET' || inv.field!==original.field ||
          inv.remove!==!original.beforePresent || !same(inv.value,original.beforePresent?original.before:null) ||
          state.revisions.get(inv.field)!==original.fieldRevision)) throw Error('Invalid SET inverse');
      if ((t==='ADD'||t==='SUBTRACT') && (!state || inv.type!==(t==='ADD'?'SUBTRACT':'ADD') ||
          inv.field!==original.field || inv.amount!==original.amount || !number(state.doc[inv.field]) ||
          !number(state.doc[inv.field]+(inv.type==='ADD'?inv.amount:-inv.amount)))) throw Error('Invalid numeric inverse');
    }
  }
  async syncDir(dir) { try { const h=await fs.open(dir,'r'); try { await h.sync(); } finally { await h.close(); } } catch(e) { throw new StoreError('STORAGE_ERROR', 'Directory synchronization is required for durable commits', {directory:dir, cause:e.code || String(e)}); } }
  async atomicWrite(file,data) {
    const dir=path.dirname(file); await fs.mkdir(dir,{recursive:true});
    const tmp=path.join(dir,`.tmp-${randomUUID()}`);
    try { const h=await fs.open(tmp,'wx'); try { await h.writeFile(data); if (dir===path.join(this.root,'journal')) crashAt('after-temp-write'); await h.sync(); if (dir===path.join(this.root,'journal')) crashAt('after-temp-sync'); } finally { await h.close(); } await fs.rename(tmp,file); if (dir===path.join(this.root,'journal')) crashAt('after-rename'); await this.syncDir(dir); }
    finally { await fs.rm(tmp,{force:true}).catch(()=>{}); }
  }
  async materialize(c,id) {
    const dir=path.join(this.root,'data',c), file=path.join(dir,`${id}.json`);
    const state=this.getDoc(c,id);
    if (state) await this.atomicWrite(file,JSON.stringify(state.doc,null,2)+'\n');
    else { await fs.rm(file,{force:true}); await this.syncDir(dir).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
  }
  async reconcile() {
    // Journal is authoritative: remove stale materialized records, then rebuild.
    const data=path.join(this.root,'data');
    await fs.rm(data,{recursive:true,force:true}); await fs.mkdir(data,{recursive:true});
    for (const k of this.docs.keys()) { const [c,id]=k.split('\u0000'); await this.materialize(c,id); }
  }
  async commit(entry) {
    const sequence=this.sequence+1, operationId=randomUUID();
    const payload={...entry,operationId,sequence,timestamp:new Date().toISOString()};
    const e={...payload,checksum:digest(payload)};
    const file=path.join(this.root,'journal',seqFile(sequence,operationId));
    try { crashAt('before-journal-write'); await this.atomicWrite(file,JSON.stringify(e)+'\n'); }
    catch(cause) { this.poisoned=true; throw new StoreError('STORAGE_ERROR','Journal commit failed; reopen to determine outcome',{cause:String(cause)}); }
    // Publishing head.json is the durable commit boundary. A journal file
    // without a corresponding head advance is an uncommitted orphan.
    try {
      crashAt('before-head-write');
      await this.atomicWrite(path.join(this.root,'head.json'),
        JSON.stringify({version:1,sequence,checksum:e.checksum})+'\n');
    } catch(cause) { this.poisoned=true; throw new StoreError('STORAGE_ERROR','Journal head commit failed; reopen to determine outcome',{cause:String(cause)}); }
    crashAt('after-journal-commit');
    try {
      this.apply(e); this.ops.set(operationId,e); this.entries.push(e); this.sequence=sequence; this.headChecksum=e.checksum;
      crashAt('before-materialize');
      await this.materialize(e.collection,e.documentId);
      crashAt('after-materialize');
    } catch(cause) { this.poisoned=true; throw new StoreError('STORAGE_ERROR','Committed journal entry requires recovery',{operationId,cause:String(cause)}); }
    return {operationId,sequence};
  }
  async create(c,id,document) { return this.serialize(async()=>{this.names(c,id); if (!isObject(document)||!validJson(document)) err('INVALID_DOCUMENT','Document must be a plain JSON object'); if(this.getDoc(c,id)) err('DOCUMENT_EXISTS','Document exists'); return this.commit({type:'CREATE',collection:c,documentId:id,document:clone(document)});}); }
  async get(c,id) { this.assertOpen(); this.names(c,id); await this.queue; this.assertOpen(); return clone(this.getDoc(c,id)?.doc ?? null); }
  async list(c) { this.assertOpen(); this.names(c); await this.queue; this.assertOpen(); return [...this.docs].filter(([k])=>k.startsWith(c+'\u0000')).map(([k,v])=>({id:k.split('\u0000')[1],document:clone(v.doc)})).sort((a,b)=>a.id.localeCompare(b.id,'en')); }
  async query(c,params) { this.assertOpen(); if(!(params instanceof URLSearchParams)) err('INVALID_QUERY','Expected URLSearchParams'); const groups=new Map(); for(const [f,v] of params){this.validateField(f); if(!groups.has(f)) groups.set(f,[]); groups.get(f).push(v.toLowerCase());} return (await this.list(c)).filter(({document})=>[...groups].every(([f,values])=>{const x=document[f]; const s=(typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))?String(x).toLowerCase():null; return s!==null && values.some(v=>s.includes(v));})); }
  async set(c,id,field,value) { return this.serialize(async()=>{this.names(c,id);this.validateField(field);if(!validJson(value)) err('INVALID_DOCUMENT','Invalid JSON value'); const state=this.getDoc(c,id);if(!state)err('DOCUMENT_NOT_FOUND','Missing document');const present=Object.hasOwn(state.doc,field);return this.commit({type:'SET',collection:c,documentId:id,field,value:clone(value),beforePresent:present,before:present?clone(state.doc[field]):undefined,fieldRevision:(state.revisions.get(field)||0)+1});}); }
  async numeric(type,c,id,field,amount) { return this.serialize(async()=>{this.names(c,id);this.validateField(field);if(!number(amount)||amount<=0)err('INVALID_NUMBER','Amount must be positive safe integer');const state=this.getDoc(c,id);if(!state)err('DOCUMENT_NOT_FOUND','Missing document');if(!Object.hasOwn(state.doc,field))err('FIELD_NOT_FOUND','Missing numeric field');const current=state.doc[field];if(!number(current))err('INVALID_TYPE','Field must be safe integer');const result=current+(type==='ADD'?amount:-amount);if(!number(result))err('INVALID_NUMBER','Result exceeds safe integer range');return this.commit({type,collection:c,documentId:id,field,amount,before:current,after:result});}); }
  add(c,id,f,amount){return this.numeric('ADD',c,id,f,amount);}
  subtract(c,id,f,amount){return this.numeric('SUBTRACT',c,id,f,amount);}
  async delete(c,id){return this.serialize(async()=>{this.names(c,id);const state=this.getDoc(c,id);if(!state)err('DOCUMENT_NOT_FOUND','Missing document');return this.commit({type:'DELETE',collection:c,documentId:id,document:clone(state.doc)});});}
  async compensate(operationId) { return this.serialize(async()=>{
    const original=this.ops.get(operationId);if(!original)return {operationId,status:'NOT_FOUND'};
    if(original.type==='COMPENSATE')return {operationId,status:'CONFLICT',reason:'NOT_COMPENSABLE'};
    if(original.compensationId)return {operationId,status:'ALREADY_COMPENSATED',compensationId:original.compensationId};
    const state=this.getDoc(original.collection,original.documentId), t=original.type;
    let inverse;
    if(t==='CREATE') {
      if(!state||state.generation!==original.operationId||state.changed)return {operationId,status:'CONFLICT',reason:'DOCUMENT_MODIFIED'};
      inverse={type:'DELETE'};
    } else if(t==='DELETE') {
      if(state)return {operationId,status:'CONFLICT',reason:'DOCUMENT_EXISTS'};
      if(this.entries.some(e=>e.sequence>original.sequence && e.collection===original.collection && e.documentId===original.documentId && e.type==='CREATE'))return {operationId,status:'CONFLICT',reason:'DOCUMENT_REUSED'};
      inverse={type:'CREATE',document:clone(original.document)};
    } else if(t==='SET') {
      if(!state||state.revisions.get(original.field)!==original.fieldRevision)return {operationId,status:'CONFLICT',reason:'FIELD_MODIFIED'};
      inverse={type:'SET',field:original.field,value:original.beforePresent?clone(original.before):null,remove:!original.beforePresent};
    } else {
      if(!state||!number(state.doc[original.field]))return {operationId,status:'CONFLICT',reason:'INVALID_FIELD'};
      const type=t==='ADD'?'SUBTRACT':'ADD',next=state.doc[original.field]+(type==='ADD'?original.amount:-original.amount);
      if(!number(next))return {operationId,status:'CONFLICT',reason:'INVALID_NUMBER'};
      inverse={type,field:original.field,amount:original.amount};
    }
    const res=await this.commit({type:'COMPENSATE',collection:original.collection,documentId:original.documentId,compensates:operationId,inverse});
    return {operationId,status:'SUCCESS',compensationId:res.operationId};
  }); }
  async getOperation(id) { this.assertOpen(); await this.queue; this.assertOpen(); const e=this.ops.get(id);if(!e)return null;return clone({...e,status:e.compensationId?'COMPENSATED':'COMMITTED',compensationId:e.compensationId}); }
  async history(c,id) { this.assertOpen();this.names(c,id);await this.queue;this.assertOpen();return this.entries.filter(e=>e.collection===c&&e.documentId===id).map(e=>({operationId:e.operationId,sequence:e.sequence,type:e.type,...(e.field?{field:e.field}:{}),timestamp:e.timestamp,status:e.compensationId?'COMPENSATED':'COMMITTED',...(e.compensates?{compensates:e.compensates}:{})})); }
}
