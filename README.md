# Vela CF — Cloudflare Native Monorepo

基于 Cloudflare 原生生态重构的轻量化 **Vela**：全栈 TypeScript，一个 Worker、一个模型、一个数据库。面向海外用户，全新上线，不迁移旧系统数据。

| 文件 | 内容 |
| --- | --- |
| [agent.md](agent.md) | 工作规则、硬边界、排期。动手前先读 |
| [docs/LLD.md](docs/LLD.md) | 架构、表结构、接口、合规清单 |
| [docs/DESIGN.md](docs/DESIGN.md) | 页面、交互、设计变量；画板源码在 `docs/design/` |
| [boundaries.json](boundaries.json) | 机器强制的边界与排期，`npm run check` 检查 |

## 目录结构

```text
vela_cf/
├── apps/
│   └── api/             # 唯一的 Worker：Hono + Better Auth + Drizzle/D1 + Vercel AI SDK（OpenAI 兼容接口 + Gemini API），同源托管前端
└── packages/
    ├── astrology/       # 中西排盘纯函数（iztro + lunar-javascript + Swiss Ephemeris WASM）+ 回归测试
    └── shared/          # 订阅档位 (free/go/pro)、配额上限、API 类型
```

- 前端 `apps/web` 尚未创建：复用 `../vela/frontend-v2` 的 UI 组件，数据层重写，构建产物由 `apps/api` 托管（LLD §5）。
- Admin 界面、对外 Remote MCP、Workers AI、KV、Cron、Langfuse、PostHog 不在第一阶段（LLD §6）。

## 当前状态

只有配置骨架，三个 workspace 都还没有 `src/`，`npm run typecheck` 会因为没有输入文件而失败。下一步是 LLD §9 的 Phase 0。

## 快速开始（切片 1 之后可用）

```bash
npm install
npm run typecheck

cd apps/api
cp ../../.env.example .dev.vars          # 填入真实值
npm run db:generate                      # 由 Drizzle schema 生成迁移
npx wrangler d1 migrations apply vela-db --local
npm run dev
```

## 上线前必须完成

见 LLD §8.5 的检查清单，其中两项会阻塞上线：

- 购买 Swiss Ephemeris Professional License 并收到会签件。
- 确定生产用的模型供应商与型号（代码已同时支持 OpenAI 兼容接口与 Gemini API），隐私政策与服务条款经律师审阅后上线。

## 与原 `vela` 仓库的对应关系

- **排盘契约与黄金验证集**：`../vela/vela-agent/backend/app/astrology_capabilities.py`、`../vela/vela-agent/backend/tests/golden/charts_golden.json`。
- **Prompt 与预设**：`../vela/vela-agent/backend/product-presets/standard-v1`，导入 D1 `products` 表。
- **迁移背景**：`../vela/docs/operations/cf-mcp-migration-and-auth-plan-20261113.md`。
