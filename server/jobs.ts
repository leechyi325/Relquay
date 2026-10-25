import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, FileLocation } from '../shared/protocol.ts';
import { Files, HttpError } from './files.ts';

export class Jobs {
  records: Job[] = []; child?: ChildProcess; stopping = false;
  constructor(public stateDir: string, private files: Files, private envFile?: string) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const database = path.join(stateDir, 'jobs.json');
    if (fs.existsSync(database)) this.records = JSON.parse(fs.readFileSync(database, 'utf8'));
    for (const job of this.records) if (job.status === 'running' || job.status === 'cancelling') {
      job.status = 'interrupted'; job.endedAt = new Date().toISOString();
    }
    this.persist();
  }
  persist() {
    const dest = path.join(this.stateDir, 'jobs.json');
    fs.writeFileSync(dest + '.tmp', JSON.stringify(this.records), { mode: 0o600 });
    fs.renameSync(dest + '.tmp', dest);
  }
  async add(title: string, command: string, cwd: FileLocation) {
    await this.files.resolve(cwd);
    if (this.records.filter(j => ['running', 'queued', 'cancelling'].includes(j.status)).length >= 30) throw new HttpError(429, '任务队列已满');
    const job: Job = { id: randomUUID(), title, command, cwd, createdAt: new Date().toISOString(), status: 'queued' };
    this.records.push(job); this.persist(); void this.pump(); return job;
  }
  async pump() {
    if (this.child || this.stopping) return;
    const job = this.records.find(j => j.status === 'queued');
    if (!job) return;
    // Reserve before awaiting path lookup to prevent concurrent add calls starting two workers.
    job.status = 'running'; job.startedAt = new Date().toISOString(); this.persist();
    const reservation = {} as ChildProcess; this.child = reservation;
    try {
      const cwd = await this.files.resolve(job.cwd);
      if (this.stopping || job.status !== 'running') {
        job.status = this.stopping ? 'interrupted' : 'cancelled'; job.endedAt = new Date().toISOString();
        this.child = undefined; this.persist(); void this.pump(); return;
      }
      const log = fs.openSync(path.join(this.stateDir, `${job.id}.log`), 'a', 0o600);
      const args = this.envFile ? ['-c', 'source "$1"; eval "$2"', 'studio-job', this.envFile, job.command] : ['-c', job.command];
      const child = spawn('/bin/bash', args, { cwd, env: { ...process.env, WORKERS: '1', OMP_NUM_THREADS: '2' }, detached: true, stdio: ['ignore', log, log] });
      fs.closeSync(log); this.child = child;
      child.once('error', e => { fs.appendFileSync(path.join(this.stateDir, `${job.id}.log`), `\n${e.message}\n`); });
      child.once('close', (code) => {
        job.exitCode = code; job.endedAt = new Date().toISOString();
        job.status = this.stopping ? 'interrupted' : job.status === 'cancelling' ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
        this.child = undefined; this.persist(); void this.pump();
      });
    } catch(e) {
      job.status = 'failed'; job.endedAt = new Date().toISOString(); this.child = undefined;
      fs.appendFileSync(path.join(this.stateDir, `${job.id}.log`), String(e)); this.persist(); void this.pump();
    }
  }
  cancel(id: string) {
    const job = this.records.find(j => j.id === id);
    if (!job) throw new HttpError(404, '任务不存在');
    if (job.status === 'queued') { job.status = 'cancelled'; job.endedAt = new Date().toISOString(); }
    else if (job.status === 'running') {
      job.status = 'cancelling'; this.signal('SIGTERM');
      const child = this.child;
      const timeout = setTimeout(() => { if (child === this.child) this.signal('SIGKILL'); }, 3000); timeout.unref();
    }
    this.persist(); return job;
  }
  signal(signal: NodeJS.Signals) { if (this.child?.pid) { try { process.kill(-this.child.pid, signal); } catch {} } }
  log(id: string) {
    if (!this.records.some(j => j.id === id)) throw new HttpError(404, '任务不存在');
    const file = path.join(this.stateDir, `${id}.log`);
    if (!fs.existsSync(file)) return '';
    const fd = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(fd).size, data = Buffer.alloc(Math.min(size, 128 * 1024)); fs.readSync(fd, data, 0, data.length, Math.max(0, size - data.length)); return data.toString('utf8'); }
    finally { fs.closeSync(fd); }
  }
  stop() { this.stopping = true; this.signal('SIGTERM'); }
}
