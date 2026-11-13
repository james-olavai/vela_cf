#!/usr/bin/env node
// 项目边界检查：对照 boundaries.json，超出范围即失败。零依赖。
//   node scripts/check-boundaries.mjs            人读报告，违规时退出码 1
//   node scripts/check-boundaries.mjs --hook     Claude Code 钩子：只在违规时输出，退出码 2
//   node scripts/check-boundaries.mjs --root DIR 检查另一个目录（自测用）
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const hook = args.includes('--hook');
const root = args.includes('--root')
  ? args[args.indexOf('--root') + 1]
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// ponytail: 正则剥注释与尾逗号，够用于 wrangler.jsonc；出现解析不了的写法再换 jsonc-parser
const readJsonc = (p) =>
  JSON.parse(
    readFileSync(p, 'utf8')
      .replace(/("(?:\\.|[^"\\])*")|\/\/.*|\/\*[\s\S]*?\*\//g, '$1')
      .replace(/,(\s*[}\]])/g, '$1'),
  );

const B = readJson(join(root, 'boundaries.json'));
const errors = [];
const report = [];
const HOW = '如确有必要：先在 docs/LLD.md §6 写明触发条件，由负责人批准后修改 boundaries.json。';

// 1. workspace 集合
const found = ['apps', 'packages'].flatMap((d) =>
  existsSync(join(root, d))
    ? readdirSync(join(root, d), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${d}/${e.name}`)
    : [],
);
for (const ws of found) {
  if (!B.workspaces[ws]) errors.push(`未批准的 workspace：${ws}（只允许 ${Object.keys(B.workspaces).filter((k) => k !== '.').join('、')}）`);
}

const SRC = /\.(ts|tsx|js|jsx|mjs|css)$/;
const NOT_SRC = /(\.test\.|\.d\.ts$|\.generated\.)/;
const sourceFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && SRC.test(e.name) && !NOT_SRC.test(e.name))
        .map((e) => join(e.parentPath, e.name))
    : [];

for (const [ws, rule] of Object.entries(B.workspaces)) {
  const dir = join(root, ws);

  // 2. 依赖白名单
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (!rule.dependencies.includes(dep)) errors.push(`${ws}：未批准的依赖 ${dep}`);
    }
  }
  if (ws === '.') continue;

  // 3. 代码行数预算
  const files = sourceFiles(join(dir, 'src'));
  const texts = files.map((f) => readFileSync(f, 'utf8'));
  const lines = texts.reduce((n, t) => n + t.split('\n').length, 0);
  report.push(`${ws.padEnd(20)} ${String(lines).padStart(5)} / ${rule.maxSourceLines} 行`);
  if (lines > rule.maxSourceLines) errors.push(`${ws}：src 共 ${lines} 行，超出预算 ${rule.maxSourceLines}。先删再加。`);

  // 4. API 路由数
  if (rule.maxApiRoutes != null) {
    // ponytail: 按 Hono 的 .get('/…') 写法粗略计数；改用别的注册方式时这里要跟着改
    const routes = texts.reduce((n, t) => n + (t.match(/\.(get|post|put|patch|delete|all|on)\(\s*['"`]\//g) ?? []).length, 0);
    report.push(`${''.padEnd(20)} ${String(routes).padStart(5)} / ${rule.maxApiRoutes} 个路由`);
    if (routes > rule.maxApiRoutes) errors.push(`${ws}：注册了 ${routes} 个路由，超出上限 ${rule.maxApiRoutes}（接口清单见 docs/LLD.md §4.4）`);
  }

  // 5. wrangler 配置
  if (existsSync(join(dir, 'wrangler.toml')) || existsSync(join(dir, 'wrangler.json'))) {
    errors.push(`${ws}：只允许 wrangler.jsonc`);
  }
  const wr = join(dir, 'wrangler.jsonc');
  if (existsSync(wr)) {
    const cfg = readJsonc(wr);
    for (const scope of [cfg, ...Object.values(cfg.env ?? {})]) {
      for (const key of Object.keys(scope)) {
        if (!B.wrangler.allowedKeys.includes(key)) errors.push(`${ws}/wrangler.jsonc：未批准的配置项 ${key}（新绑定或新平台能力）`);
      }
      if ((scope.d1_databases ?? []).length > B.wrangler.maxD1Databases) errors.push(`${ws}/wrangler.jsonc：D1 数据库超过 ${B.wrangler.maxD1Databases} 个`);
    }
  }
}

// 6. 排期（只提醒，不判失败）
const today = new Date().toISOString().slice(0, 10);
const open = B.schedule.phases.filter((p) => !p.done);
const overdue = open.filter((p) => p.deadline < today);
const current = open[0];

if (hook) {
  if (errors.length) {
    console.error(`项目边界检查未通过（boundaries.json）：\n- ${errors.join('\n- ')}\n${HOW}\n请撤回这次改动中越界的部分，不要修改 boundaries.json 来让检查通过。`);
    process.exit(2);
  }
  process.exit(0);
}

console.log('代码预算');
for (const line of report) console.log('  ' + line);
console.log('排期');
if (current) console.log(`  当前阶段：${current.name}，截止 ${current.deadline}`);
else console.log('  全部阶段已完成');
for (const p of overdue) console.log(`  ! 已逾期：${p.name}（${p.deadline}）。砍范围，不要加人加功能；完成后把 done 改为 true。`);
if (errors.length) {
  console.error(`\n边界检查未通过：\n- ${errors.join('\n- ')}\n${HOW}`);
  process.exit(1);
}
console.log('\n边界检查通过');
