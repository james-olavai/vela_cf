#!/usr/bin/env node
// 项目边界检查：对照 boundaries.json，超出范围即失败。零依赖。
//   node scripts/check-boundaries.mjs            人读报告，违规时退出码 1
//   node scripts/check-boundaries.mjs --hook     Claude Code 钩子：只在违规时输出，退出码 2
//   node scripts/check-boundaries.mjs --root DIR 检查另一个目录（自测用）
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const hook = args.includes('--hook');
const root = args.includes('--root')
  ? args[args.indexOf('--root') + 1]
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

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

const sec = B.firebase?.security ?? {};

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

  // 4. Cloud Functions 数量上限与 LLM Tool 防注入隔离检查
  if (rule.maxCallableFunctions != null) {
    // ponytail: 按 onCall( / onCallGenkit( / onRequest( 调用计数
    const fnCount = texts.reduce((n, t) => n + (t.match(/\b(onCall|onCallGenkit|onRequest)\s*\(/g) ?? []).length, 0);
    report.push(`${''.padEnd(20)} ${String(fnCount).padStart(5)} / ${rule.maxCallableFunctions} 个函数`);
    if (fnCount > rule.maxCallableFunctions) {
      errors.push(`${ws}：注册了 ${fnCount} 个 Cloud Functions，超出上限 ${rule.maxCallableFunctions}（清单见 docs/LLD.md §4.4）`);
    }

    if (sec.maxAstrologyTools != null) {
      // Table-backed factory registers each spec, plus the progressive Reference tool.
      // Count concrete table entries rather than factory invocations.
      const toolCount = texts.reduce((n, t, i) => {
        if (files[i].endsWith('/tools.ts')) {
          const table = t.match(/const specs:[\s\S]*?=\s*\[([\s\S]*?)\n\s*\];/);
          if (!table) { errors.push('tools.ts：无法识别工具目录，检查器需要同步更新'); return n; }
          return n + (table[1].match(/\[\s*['"][a-zA-Z][a-zA-Z0-9]*['"]\s*,/g) ?? []).length + (t.includes('tools.loadSkillReference =') ? 1 : 0);
        }
        return n + (t.match(/\b(?:defineTool|dynamicTool)\s*\(/g) ?? []).length;
      }, 0);
      report.push(`${''.padEnd(20)} ${String(toolCount).padStart(5)} / ${sec.maxAstrologyTools} 个 AI Tool`);
      if (toolCount > sec.maxAstrologyTools) {
        errors.push(`${ws}：注册了 ${toolCount} 个 defineTool，超出上限 ${sec.maxAstrologyTools}（只允许 4 个排盘纯函数）`);
      }
    }

    if (sec.forbidSideEffectsInTools) {
      for (let i = 0; i < files.length; i++) {
        const text = texts[i];
        if (/\b(?:defineTool|dynamicTool)\b/.test(text)) {
          const rel = relative(root, files[i]);
          if (/from\s+['"]firebase-admin|from\s+['"]stripe|\bfetch\s*\(/.test(text)) {
            errors.push(`${rel}：定义 AI Tool 的文件严禁引入 firebase-admin / stripe 或调用 fetch（LLM 防注入零副作用边界，见 docs/LLD.md §4.6）`);
          }
        }
      }
    }
  }

  // 5. 禁止遗留的 wrangler 配置
  for (const legacy of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    if (existsSync(join(dir, legacy))) {
      errors.push(`${ws}：已迁移至 Firebase，不允许存在 ${legacy}`);
    }
  }
}

// 6. firebase.json 与 firestore.rules 安全检查
const fbPath = join(root, 'firebase.json');
if (existsSync(fbPath) && B.firebase) {
  const fb = readJson(fbPath);
  for (const key of Object.keys(fb)) {
    if (!B.firebase.allowedTopKeys.includes(key)) {
      errors.push(`firebase.json：未批准的顶层配置项 ${key}（新平台能力需先审批）`);
    }
  }
  if (fb.firestore?.location && fb.firestore.location !== B.firebase.region) {
    errors.push(`firebase.json：Firestore 区域必须为 ${B.firebase.region}，当前为 ${fb.firestore.location}`);
  }
}

const rulesPath = join(root, 'firestore.rules');
if (!existsSync(rulesPath)) {
  errors.push('缺少 firestore.rules 文件');
} else if (sec.forbidOpenFirestoreWrites) {
  const rulesText = readFileSync(rulesPath, 'utf8');
  if (/allow\s+([^;]*\bwrite\b[^;]*):\s*if\s+true\s*;/.test(rulesText)) {
    errors.push('firestore.rules：严禁出现无条件开放写权限（allow write: if true）');
  }
}

// 7. 排期（只提醒，不判失败）
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
