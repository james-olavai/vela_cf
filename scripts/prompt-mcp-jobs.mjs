import { mkdir, readFile, writeFile, readdir, rename, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)).digest('hex');
export async function confinedFile(root, file) {
  const base = await realpath(root), path = await realpath(resolve(base, file)), rel = relative(base, path);
  if (isAbsolute(file) || rel.startsWith('..') || isAbsolute(rel)) throw new Error('资源必须位于配置目录内');
  return path;
}
export async function createEvaluationJobs({ directory, evaluate, prepare }) {
  await mkdir(directory, { recursive: true, mode:0o700 });
  const jobs = new Map(), active = new Map(), writes = new Map();
  async function save(job) {
    const path = resolve(directory, `${job.id}.json`);
    const serialized = JSON.stringify(job);
    const pending = (writes.get(job.id) || Promise.resolve()).then(async () => {
      await writeFile(`${path}.tmp`, serialized, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    writes.set(job.id, pending.catch(() => {}));
    await pending;
  }
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const job = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
    if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; await save(job); }
    jobs.set(job.id, job);
  }
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      for (const job of jobs.values()) {
        if (job.status !== 'queued') continue;
        const controller = new AbortController(); active.set(job.id, controller);
        job.status = 'running'; await save(job);
        const timer = setTimeout(() => controller.abort(new Error('评测已超时')), job.snapshot.timeoutMs);
        try {
          for (let repeat = 0; repeat < job.snapshot.repeats; repeat++) for (const item of job.snapshot.cases) {
            controller.signal.throwIfAborted();
            const result = await evaluate(structuredClone(job.snapshot), item, controller.signal);
            controller.signal.throwIfAborted();
            job.results.push({ caseId: item.id, repeat, result }); await save(job);
          }
          controller.signal.throwIfAborted();
          job.status = 'completed';
        } catch (error) {
          if (job.status !== 'cancelled') job.status = 'failed';
          job.error = controller.signal.aborted ? '评测已取消或超时；部分用量可能已经发生' : '评测失败；请检查本地模型连接及配置';
        } finally { clearTimeout(timer); active.delete(job.id); await save(job); }
      }
    } finally { running = false; }
  }
  function find(id) { const job = jobs.get(id); if (!job) throw new Error('没有此评测'); return job; }
  return {
    async start(input) {
      if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 4) throw new Error('最多排队四个任务');
      const snapshot = structuredClone(await prepare(input));
      if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 4) throw new Error('最多排队四个任务');
      const job = { id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), snapshot, hash: digest(snapshot), results: [] };
      jobs.set(job.id, job); await save(job); setImmediate(() => drain().catch(() => {}));
      return { jobId: job.id, status: job.status, snapshotHash: job.hash };
    },
    get(id, cursor = 0, limit = 1) {
      if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('分页范围无效');
      const j = find(id); return { jobId: id, status: j.status, snapshotHash: j.hash, provenance: j.snapshot.provenance, completed: j.results.length, total: j.snapshot.cases.length * j.snapshot.repeats, error: j.error, results: structuredClone(j.results.slice(cursor, cursor + limit)), nextCursor: cursor + limit < j.results.length ? cursor + limit : null };
    },
    async cancel(id) {
      const j = find(id); if (['queued', 'running'].includes(j.status)) { j.status = 'cancelled'; active.get(id)?.abort(); await save(j); }
      return { jobId: id, status: j.status };
    },
    compare(left, right) {
      const a = find(left), b = find(right);
      const conditions = j => ({ cases: j.snapshot.cases, repeats: j.snapshot.repeats, toolMode: j.snapshot.toolMode, maxOutputTokens: j.snapshot.maxOutputTokens, runtime: j.snapshot.provenance?.runtimeCommit, model: j.snapshot.bundle.modelName, temperature:j.snapshot.bundle.temperature, tier:j.snapshot.tier, runtimeDiffHash:j.snapshot.provenance?.runtimeDiffHash });
      const comparable = digest(conditions(a)) === digest(conditions(b));
      return { comparable, status: [a.status, b.status], verdict: '待人工盲评；不自动宣布优胜', pairs: a.results.map(r => { const other=b.results.find(x=>x.caseId===r.caseId && x.repeat===r.repeat); return { caseId: r.caseId, repeat: r.repeat, A: r.result.text, B: other?.result.text, hardFailures: [r.result.diagnostics?.mismatches, other?.result.diagnostics?.mismatches] }; }), limitation: 'A/B 标签仅隐藏版本名称；顺序和文字可能揭示来源，不能视为严格双盲' };
    },
  };
}
