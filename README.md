# Vela — Firebase / Google Cloud Monorepo

基于 Firebase 与 Google Cloud（`asia-southeast1`）原生生态构建的轻量化 **Vela**（仓库名保持 `vela_cf` 不变）：全栈 TypeScript，Firebase Hosting + Cloud Functions (2nd gen) + Genkit + Firestore + Vertex AI (Gemini)。面向海外用户，全新上线，直接复用 Google Cloud 赠金/积分，不迁移旧系统数据。

| 文件 | 内容 |
| --- | --- |
| [agent.md](agent.md) | 工作规则、硬边界、排期。动手前先读 |
| [docs/LLD.md](docs/LLD.md) | 架构、Firestore 结构、Cloud Functions、合规清单 |
| [docs/DESIGN.md](docs/DESIGN.md) | 页面、交互、设计变量；画板源码在 `docs/design/` |
| [boundaries.json](boundaries.json) | 机器强制的边界与排期，`npm run check` 检查 |

## 目录结构

```text
vela_cf/
├── firebase.json        # Firebase Hosting / Functions / Firestore / Emulators 配置
├── firestore.rules      # Firestore 安全规则
├── firestore.indexes.json
├── apps/
│   └── api/             # Cloud Functions (2nd gen, Node 22, asia-southeast1) + Genkit + Dotprompt
└── packages/
    ├── astrology/       # 中西排盘纯函数（iztro + lunar-javascript + Swiss Ephemeris WASM）+ 回归测试
    └── shared/          # 订阅档位 (free/go/pro)、配额上限、共享 Schema 与类型
```

- 前端 `apps/web` 尚未创建：复用 `../vela/frontend-v2` 的 UI 组件，数据层基于 Firebase Web SDK 重写，构建产物由 Firebase Hosting 托管（LLD §5）。
- Admin 界面、对外 Remote MCP、Cloud SQL、定时任务、Langfuse、PostHog / Analytics 不在第一阶段（LLD §6）。

## 当前状态

已完成架构切换与边界规则对齐，三个 workspace 还没有 `src/`，下一步是 LLD §9 的 Phase 0。

## 快速开始（切片 1 之后可用）

```bash
npm install
npm run check
npm run typecheck

cp .env.example apps/api/.env
npm run dev:api                          # 启动 Firebase Local Emulators
```

## 上线前必须完成

见 LLD §8.5 的检查清单，其中两项会阻塞上线：

- 购买 Swiss Ephemeris Professional License 并收到会签件。
- 确定生产用的 Vertex AI Gemini 型号，隐私政策与服务条款经律师审阅后上线。

## 与原 `vela` 仓库的对应关系

- **排盘契约与黄金验证集**：`../vela/vela-agent/backend/app/astrology_capabilities.py`、`../vela/vela-agent/backend/tests/golden/charts_golden.json`。
- **Prompt 与预设**：`../vela/vela-agent/backend/product-presets/standard-v1`，转为 `apps/api/prompts/*.prompt` 与 Firestore `products` 集合文档。
