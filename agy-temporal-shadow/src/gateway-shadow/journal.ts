import {mkdir, open, readFile, readdir, rename, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';
import {GatewayError} from './transport.js';

export function stable(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: any) => createHash('sha256').update(stable(value)).digest('hex');
interface RecordEntry {hash: string; confirmed: boolean; response?: any}
interface State {context: string; cycle: number; done: boolean; ops: Record<string,RecordEntry>}
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hashString = (value: any) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validState(value: any): value is State {
  return object(value) && hashString(value.context) && Number.isSafeInteger(value.cycle) && value.cycle >= 1 &&
    typeof value.done === 'boolean' && object(value.ops) && Object.values(value.ops).every(op =>
      object(op) && hashString(op.hash) && typeof op.confirmed === 'boolean' &&
      (!op.confirmed || Object.hasOwn(op, 'response')));
}

// One writer per durable directory. A stale crash lock requires operator verification/removal.
export class GatewayJournal {
  private constructor(readonly dir: string, private state: State) {}
  // First-use provisioning is explicit and offline. A running worker must never mistake
  // lost storage for a new worker, or erase old receipts by initializing over any files.
  static async initialize(dir: string, context: any) {
    if (!isAbsolute(dir)) throw new GatewayError('DURABLE_STATE_DIR_ABSOLUTE_REQUIRED');
    await mkdir(dir, {recursive:true, mode:0o700});
    const lock = await open(join(dir,'worker.lock'), 'wx', 0o600).catch(() => {throw new GatewayError('JOURNAL_LOCKED');});
    try {
      await lock.writeFile(String(process.pid)); await lock.sync();
      if ((await readdir(dir)).some(name => name !== 'worker.lock')) throw new GatewayError('JOURNAL_NOT_EMPTY');
      await new GatewayJournal(dir,{context:digest(context),cycle:1,done:false,ops:{}}).save();
    } finally { await lock.close(); await unlink(join(dir,'worker.lock')); }
  }
  static async acquire(dir: string, context: any) {
    if (!isAbsolute(dir)) throw new GatewayError('DURABLE_STATE_DIR_ABSOLUTE_REQUIRED');
    const lock = await open(join(dir,'worker.lock'), 'wx', 0o600).catch((e: any) => {
      throw new GatewayError(e.code === 'ENOENT' ? 'JOURNAL_MISSING' : 'JOURNAL_LOCKED');
    });
    await lock.writeFile(String(process.pid)); await lock.sync(); await lock.close();
    try {
      let state: State;
      try { state = JSON.parse(await readFile(join(dir,'current.json'),'utf8')); }
      catch (e: any) { throw new GatewayError(e.code === 'ENOENT' ? 'JOURNAL_MISSING' : 'JOURNAL_INVALID'); }
      if (!validState(state)) throw new GatewayError('JOURNAL_INVALID');
      if (state.context !== digest(context)) throw new GatewayError('JOURNAL_CONTEXT_MISMATCH');
      // Reading a valid journal does not rewrite it: preserve bytes before reconciliation.
      return new GatewayJournal(dir,state);
    } catch (e) { await unlink(join(dir,'worker.lock')); throw e; }
  }
  private async save() {
    await this.writeAtomic('current.json',this.state);
  }
  private async writeAtomic(name: string, value: State) {
    const temp = join(this.dir,name + '.tmp');
    const f = await open(temp,'w',0o600);
    try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
    await rename(temp,join(this.dir,name));
    // POSIX directory sync makes rename durable; Windows does not support opening a directory.
    if (process.platform !== 'win32') { const d = await open(this.dir,'r'); try {await d.sync();} finally {await d.close();} }
  }
  assertCertain() {
    if (Object.values(this.state.ops).some(v => !v.confirmed)) throw new GatewayError('RECONCILIATION_REQUIRED');
  }
  async once<T>(key: string, request: any, operation: () => Promise<T>): Promise<T> {
    const hash = digest(request), old = this.state.ops[key];
    if (old) {
      if (old.hash !== hash) throw new GatewayError('IDEMPOTENCY_CONFLICT');
      if (!old.confirmed) throw new GatewayError('RECONCILIATION_REQUIRED');
      return structuredClone(old.response) as T;
    }
    this.state.ops[key] = {hash,confirmed:false}; await this.save();
    const response = await operation();
    this.state.ops[key] = {hash,confirmed:true,response}; await this.save();
    return response;
  }
  async fresh<T>(prefix: string, request: any, operation: () => Promise<T>) {
    const n = Object.keys(this.state.ops).filter(k => k.startsWith(prefix + ':')).length;
    return this.once(prefix + ':' + n, request, operation);
  }
  receipt<T>(key: string, request: any): T|undefined {
    const old = this.state.ops[key];
    if (!old) return undefined;
    if (old.hash !== digest(request)) throw new GatewayError('IDEMPOTENCY_CONFLICT');
    if (!old.confirmed) throw new GatewayError('RECONCILIATION_REQUIRED');
    return structuredClone(old.response) as T;
  }
  // Read-only status/collection can be repeated for a confirmed external ID. Persist the
  // collected result without marking the entire recovery sequence as an external intent.
  async remember<T>(key: string, request: any, response: T) {
    if (this.receipt(key,request) !== undefined) throw new GatewayError('RECEIPT_ALREADY_PRESENT');
    this.state.ops[key] = {hash:digest(request),confirmed:true,response}; await this.save();
  }
  async next() {
    this.assertCertain();
    if (!this.state.done) return;
    // Preserve receipts before starting another task. Empty polls are retained too.
    await this.writeAtomic(`cycle-${this.state.cycle}.json`,this.state);
    this.state = {context:this.state.context,cycle:this.state.cycle+1,done:false,ops:{}}; await this.save();
  }
  async complete() { this.assertCertain(); this.state.done = true; await this.save(); }
  async close() { await unlink(join(this.dir,'worker.lock')); }
}
