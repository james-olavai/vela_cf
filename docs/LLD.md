# Vela — 低层设计文档（LLD，Firebase / Google Cloud 版）

> 目标：在 `/home/yhvh/code/vela_cf`（仓库名与 `@vela-cf/*` 包名暂保持不变）构建全栈 TypeScript + Firebase / Google Cloud 原生项目，甩掉老仓库的 Python/Node 子进程双运行时、自建 Casdoor、Nginx/Redis、自建 Admin 后台以及双池 credit 账本，复用 `vela` 的排盘口径、黄金测试集、产品 Preset 与前端 UI 组件。
>
> **目标用户：海外用户。** 统一部署于 Google Cloud `asia-southeast1`（新加坡），采用 Firebase Hosting + Cloud Functions (2nd gen) + Firestore + Firebase Auth + Remote Config + Stripe 扩展 + Vertex AI (Gemini)，直接复用 Google Cloud 账户赠金与积分，不考虑大陆可达性、备案与微信/支付宝。
>
> **全新上线，不迁移旧系统的用户、档案与余额。**
>
> **第一阶段原则：一套 Firebase 项目、一个区域（`asia-southeast1`）、一个模型家族（Vertex AI Gemini）、一个数据库（Firestore），中台能力全部直接使用 Firebase / Stripe 原生控制台。** 其余组件等出现具体需求再加，见 §6。

---

## 1. 总体架构

```text
[用户浏览器]
   │
   ├─ 静态资源 ────────► Firebase Hosting（托管 apps/web 构建产物，SPA 回落）
   ├─ 登录与鉴权 ──────► Firebase Auth（Google OAuth + 邮箱密码/免密链接登录，携带 stripeRole Custom Claim）
   ├─ 站点分析 ────────► Firebase Analytics / GA4（含 Google Consent Mode v2，漏斗与转化统计）
   ├─ 实时/只读数据 ───► Cloud Firestore（客户端 SDK 按 Security Rules 直读本人档案/会话/消息/商品；写入去往 Checkout）
   └─ 流式对话与动作 ──► Cloud Functions 2nd gen (apps/api，region: asia-southeast1)
                           ├─ 防护：Firebase App Check（reCAPTCHA Enterprise）+ Auth 令牌自动校验
                           ├─ Prompt 中台：Firebase Remote Config (Server) 动态下发 Prompt、模型型号与参数（仓库预置 defaultConfig 兜底）
                           ├─ 对话：onCallGenkit 流式函数 + Genkit Tool Calling
                           ├─ 排盘：直接 import packages/astrology（Node 22 下运行 WASM，注册为 Genkit tool）
                           ├─ 模型：@genkit-ai/vertexai → Vertex AI Gemini（直接消耗 Google Cloud 赠金）
                           ├─ 数据写操作：firebase-admin/firestore（配额事务扣减、会话冻结、消息落库、城市缓存）
                           └─ 可观测：Genkit Monitoring / Cloud Logging / Cloud Trace

[原生中台矩阵（零自建后台代码）]
   ├─ Prompt 中台：Firebase Remote Config（Server 端模板，支持在线热更新、版本历史、一键回滚、按比例灰度）+ Genkit Monitoring
   ├─ 商品与订阅中台：Stripe Dashboard + Run Payments with Stripe 扩展（自动同步订阅档位与 stripeRole）+ Firestore Console（管理咨询目录 products）
   ├─ 用户中台：Firebase Console（Authentication 用户检索/封禁/删除 + Firestore 面板查看与调整 usage 配额）
   ├─ 站点分析中台：Firebase Analytics (GA4) + Stripe 营收报表
   └─ 数据合规清理：Delete User Data 官方扩展（用户注销时自动递归清理 Firestore 个人数据）
```

目录结构：

```text
vela_cf/
├── firebase.json        # Firebase Hosting / Functions / Firestore / Emulators 配置
├── firestore.rules      # Firestore 安全规则
├── firestore.indexes.json
├── apps/
│   ├── api/             # Cloud Functions (2nd gen) + Genkit flows + Remote Config 默认兜底预设
│   └── web/             # React + Vite SPA，构建产物由 Firebase Hosting 托管
└── packages/
    ├── astrology/   # 中西排盘纯函数 + 回归测试
    └── shared/      # 订阅档位 (free/go/pro)、配额上限、共享 Zod Schema 与类型
```

与原方案相比简化与调整的部分：

| 调整项 | 原因 |
| --- | --- |
| Cloudflare Worker + Hono → Cloud Functions (2nd gen) + Genkit `onCallGenkit` | 原生支持流式 Callable、自动校验 Firebase Auth 与 App Check，省去手写 SSE 封装与鉴权中间件 |
| D1 + Drizzle ORM → Firestore | 数据量小、文档与会话/消息结构天然契合，省去 SQL 迁移维护与 Cloud SQL 固定月租；客户端可安全直读 |
| Better Auth + 自建会话表 → Firebase Auth | Google OAuth 开箱即用，与 Firestore Security Rules、Callable Functions 深度集成 |
| 自写 Stripe Webhook / Checkout → `Run Payments with Stripe` 扩展 | 官方维护扩展自动处理 Checkout、Customer Portal、Webhook 同步及 `stripeRole` 权限声明 |
| 自建 Prompt 后台 → **私有 Git + Firebase Remote Config (Server)** | Git 管理文本、评测与审核；Remote Config 发布和回滚完整配置，固定产物兜底。迁移与兼容要求见 §4.7 |
| 自建 Admin 后台（原 2600 行） → **Firebase Console + Stripe Dashboard** | 用户管理、商品上下架、配额调整、财务报表全部使用官方现成控制台 |
| PostHog / Langfuse → **Firebase Analytics (GA4) + Genkit Monitoring** | `firebase` SDK 原生自带，无需引入第三方分析平台与额外数据处理方 |

---

## 2. 可复用的原项目资产（`../vela/`）

| 原项目路径 | 复用方式 | 说明 |
| --- | --- | --- |
| `vela-agent/backend/app/astrology_capabilities.py` | 契约与 Schema 基准 | `natal`、`transit_timeline`、`bazi`、`ziwei` 的输入/输出结构与版本策略。 |
| `vela-agent/backend/app/ephemeris.py`（151 行） | 西占计算口径 | `swe.calc` + `FLG_SWIEPH \| FLG_SPEED`、Placidus 宫位（`swe.houses`）、儒略日按 `hour + minute/60` 截断秒。 |
| `vela-agent/backend/app/chart.py`（2071 行） | 只移植 4 个工具用到的部分 | 其余 20 多种技法不在第一阶段，见 §3.2。 |
| `vela-agent/backend/app/astrology_eastern_sdk.py`（323 行） | 东占计算口径 | `vela-eastern-lat-v1` 真太阳时、立春/节气分界、`iztro` 参数口径。 |
| `vela-agent/backend/app/ephe/seas_18.se1`（223 KB） | 随 `packages/astrology` 打包 | 凯龙星等小行星用，Node 环境下由本地路径直接加载。 |
| `vela-agent/backend/tests/golden/charts_golden.json` | 西占回归基准 | 只用其中与 4 个工具对应的用例，见 §3.2。 |
| `vela-agent/backend/product-presets/standard-v1` | 导入 Remote Config (Server) 与 Firestore `products` | Prompt 与模型参数配置到 Firebase Remote Config Server 模板（并在代码内保留 `defaultConfig` 兜底）；商品展示卡片写入 Firestore `products` 集合。 |
| `frontend-v2/` | **只复用 UI 组件与样式** | 数据层按 Firebase SDK 重写，见 §5。 |

---

## 3. `packages/astrology`（排盘纯函数）

### 3.1 范围

四个导出函数，入参/出参用 `zod` 定义，同一份 schema 直接传给 Genkit 的 `ai.defineTool`：

- `natalWheel({ birthDateTime, latitude, longitude, timezone })`
- `transitEvents({ ...natal, windowMonths: 3 | 6 | 12 })`
- `baziPillars({ ..., yearBoundary: "lichun" | "civil_year" })`
- `ziweiPalaces({ ..., gender: "male" | "female" })`

东占用 `lunar-javascript` + `iztro@2.6.1`（与旧仓库同版本）。西占用 **Swiss Ephemeris WASM（已定）**，与旧代码是同一套算法。

**不在第一阶段**：黄金集覆盖的其余技法（合盘、组合盘、次限、太阳弧、太阳/月亮返照、法达、恒星、小限、黄道释放等）。某个商品需要时再移植，届时对应的黄金用例即为验收标准。

### 3.2 验收

一个测试脚本，超出容差即失败：

- **西占**：`charts_golden.json` 中的 `natal_A`、`natal_B`、`natal_C`、`transit_timeline_A_2026H1`。`transit_London` 是单时刻行运盘，Phase 0 确认它是否在 `transitEvents` 的契约内，是则纳入。
- **东占**：Phase 0 用旧 Python 代码对 A/B/C 三个档案导出八字与紫微结果，存为 `packages/astrology/test/eastern_golden.json`，作为东占基准。

### 3.3 Phase 0 必须先验证的三件事

1. **星历模式**：验证 WASM 版在 Node 22 下加载 `seas_18.se1` + Moshier 回退模式计算 `natal_A`，结果与黄金集完全一致。
2. **封装层许可**：商业授权只覆盖 Astrodienst 的 Swiss Ephemeris 代码，不覆盖第三方 AGPL 封装（如 `@fusionstrings/swiss-eph`）。需选用 MIT/BSD 许可的封装，或用 Emscripten 从官方 C 源码自行编译。
3. **Cloud Functions 冷启动与耗时**：在 `asia-southeast1` 的 2nd gen 函数内实测 WASM 初始化与单次排盘耗时。

### 3.4 Swiss Ephemeris 授权（已定）

- **方案**：购买 Swiss Ephemeris Professional License（Astrodienst），不走 AGPL，且排盘仅在服务端 Cloud Functions 运行，不暴露给客户端。
- **时机**：**对外上线前完成**。
- **费用**：合同模板列 700 CHF、不限项目数、有效期 6 年；下单前在 astro.com 核对。
- **上线检查项**：合同已付款并收到对方会签件，才允许挂公网域名。

---

## 4. `apps/api`（Cloud Functions 2nd gen + Genkit + 原生中台）

### 4.1 技术栈与原生中台划分

- **区域**：所有 Cloud Functions 与 Firestore 数据库统一固定在 `asia-southeast1`（新加坡）。
- **运行时**：Node.js 22，Cloud Functions 2nd gen（`firebase-functions/v2`）。
- **AI 与工具调用**：`genkit` + `@genkit-ai/vertexai` + `@genkit-ai/firebase`，用 `onCallGenkit` 暴露流式接口。
- **Prompt 中台（Firebase Remote Config Server）**：
  - 使用 `firebase-admin/remote-config` 的 `getServerTemplate({ defaultConfig })` 拉取服务端模板。
  - 在 Firebase Console → Remote Config → **Server** 面板中按商品 `slug` 维护 JSON 参数（如 `preset_natal`、`preset_transit`、`preset_eastern`），包含 `systemPrompt`、`modelName`（如 `vertexai/gemini-2.5-pro`）、`temperature`、`allowedTools`。
  - 目标编辑源统一为 §4.7 的私有 Prompt 仓库；Remote Config 负责已验证 Bundle 的发布与回滚，`defaultConfig` 为固定版本的生成兜底。纯配置更新须兼容现有运行时；紧急控制台修改需回填 Git。
- **商品与用户中台（Firebase Console + Stripe Dashboard）**：
  - **咨询商品目录**：存储在 Firestore `products/{slug}`（仅含前端展示所需的 `title`、`description`、`minTier`、`isPublished`、`sortOrder`），直接在 Firebase Console 的 Firestore 面板可视化编辑与上下架。
  - **订阅档位与计费**：在 Stripe Dashboard 管理 Go / Pro 订阅商品与价格（Metadata 设置 `firebaseRole: "go"` / `"pro"`），由 `invertase/firestore-stripe-payments` 扩展自动同步至 Firestore `customers/{uid}` 及 Auth Token 的 Custom Claim `stripeRole`。
  - **用户与配额管理**：直接在 Firebase Console 的 Authentication 面板管理用户状态，在 Firestore `usage/{uid}` 面板查看或手动重置用户配额。

### 4.2 Firestore 数据结构与安全规则

数据库位于 `asia-southeast1`（Native 模式），采用以下集合层级：

```text
products/{slug}                           -- 客户端只读（已上架咨询商品展示卡片，直接在 Firebase Console 维护）
  title, description, minTier ("free"|"go"|"pro"), isPublished, sortOrder, updatedAt

locations_cache/{queryKey}                -- 仅服务端读写（城市经纬度与时区缓存）
  displayName, latitude, longitude, timezone, createdAt

usage/{uid}                               -- 客户端本人只读，仅服务端事务写（可在 Console 手动调整）
  periodStart: string                     -- ISO 时间或 YYYY-MM（当前配额周期起点）
  used: number                            -- 本周期已用成本（micro-USD）
  unlimited?: boolean                     -- Console 管理；为 true 时跳过月度预算拦截，继续记录实际用量
  overrideTier?: "free"|"go"|"pro"           -- Console 管理的套餐覆盖，跨周期保留

users/{uid}                               -- 客户端本人可读；初始化/年龄确认仅经 API 写入
  email, displayName, acceptedTermsAt, confirmedAdultAt, createdAt

users/{uid}/profiles/{profileId}          -- 客户端本人可读；写入仅经 API 校验与套餐事务
  name, birthDateTime, locationName, latitude, longitude,
  timezone (IANA), gender ("male"|"female"), createdAt, updatedAt

users/{uid}/sessions/{sessionId}          -- 客户端本人可读、可删；创建由服务端完成（冻结当时 Remote Config 的配置）
  productSlug, profileId, title,
  frozenPrompt, frozenModel, frozenTools: string[],
  createdAt, updatedAt

users/{uid}/sessions/{sessionId}/messages/{messageId}  -- 客户端本人只读；仅服务端写入
  role ("user"|"assistant"|"tool"),
  parts: Array<TextPart | ToolCallPart | ToolResultPart>,
  createdAt

customers/{uid}                           -- 由 Run Payments with Stripe 扩展自动维护
  stripeId, stripeLink
  ├─ checkout_sessions/{id}               -- 客户端本人创建以发起支付，扩展写回跳转 url
  ├─ subscriptions/{id}                   -- 客户端本人只读（status, role, current_period_start, current_period_end）
  └─ payments/{id}
```

**关键设计约束**：
- **单消息单文档**：`messages` 拆分为子集合文档，避免单文档 1 MiB 上限与高频写冲突；排盘工具返回的 JSON 保存在 `parts` 中，多轮对话直接读取历史，不重复排盘。
- **会话配置冻结**：`createSession` 时从 Firebase Remote Config Server 模板读取该 `productSlug` 当前生效的 `systemPrompt`、`modelName`、`allowedTools`，写入会话文档的 `frozen*` 字段。后续在 Remote Config 中热更新 Prompt 不会破坏进行中的历史会话。
- **档位推导**：优先读取 Auth Token 中的 `request.auth.token.stripeRole`（`"go"` | `"pro"`），缺省为 `"free"`。需要精确账期起点（`current_period_start`）时，读取 `customers/{uid}/subscriptions` 下 `status in ["active", "trialing"]` 的文档。

### 4.3 配额：惰性重置，无 Cron

- **扣减单位**：每次调用 `chat` 流式函数（一条用户消息）扣 1。
- **配额上限**：定义在 `packages/shared` 的常量 `QUOTA_LIMIT[tier]`。
- **周期起点 `currentPeriodStart`**：
  - 付费档（`go` / `pro`）：取用户当前有效订阅文档的 `current_period_start`（ISO 字符串）。
  - 免费档（`free`）：取当前 UTC 自然月 1 日 `YYYY-MM-01T00:00:00Z`。
- **Firestore 事务原子重置 + 扣减**（在 `db.runTransaction` 中执行）：

```ts
await db.runTransaction(async (tx) => {
  const ref = db.collection('usage').doc(uid);
  const snap = await tx.get(ref);
  const data = snap.data();
  const isNewPeriod = !data || data.periodStart < currentPeriodStart;
  const currentUsed = isNewPeriod ? 0 : data.used;

  if (currentUsed >= QUOTA_LIMIT[tier]) {
    throw new HttpsError('resource-exhausted', 'QUOTA_EXCEEDED');
  }

  tx.set(ref, {
    periodStart: currentPeriodStart,
    used: currentUsed + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
});
```

- **失败退还**：若 Vertex AI 在产出首个流式 chunk 前抛错，则捕获异常并通过事务将 `used` 减 1（不低于 0）。已产出 token 后的客户端中断不退还。
- **测试**：使用 Firebase Local Emulator Suite 编写针对配额事务的集成测试，覆盖：跨周期重置为 1、达到上限抛出 `resource-exhausted`、同一用户 5 个并发请求不超扣。

### 4.4 现行服务端函数清单（迁移目标见 §11）

原实现按六个函数管理；§11.7 首批迁移增加 `businessApi`，机器上限调整为七个。负责人已于 2026-11-16 允许为统一业务 API 与 Prompt 调优 API 突破该上限；目标设计见 §11，实施时同步更新函数清单、边界检查和部署/回滚清单。

因读取、档案增删与 Stripe Checkout 均由 Firestore 客户端 SDK + 扩展直接完成，后端仅需 6 个 Callable Functions（全部部署在 `asia-southeast1`，强制开启 `enforceAppCheck: true`）：

| 函数名 | 类型 | 说明 |
| --- | --- | --- |
| `chat` | `onCallGenkit`（流式） | 核心对话入口（需登录）：配额扣减、按会话冻结的 `frozenPrompt / frozenModel / frozenTools` 调用 Genkit + 排盘 Tool，流式返回并落库 `messages` |
| `createSession` | `onCall` | 需登录：校验商品权限（`tier >= minTier`）与档案归属，拉取 Remote Config (Server) 当前配置并冻结写入新会话文档 |
| `previewNatalWheel` | `onCall` | 允许未登录访客（仅校验 App Check）：实时计算本命盘预览结果，不写 Firestore、不扣配额 |
| `resolveLocation` | `onCall` | 允许未登录访客（仅校验 App Check）：查 `locations_cache`，未命中调 Open-Meteo Geocoding API 并写回缓存 |
| `exportUserData` | `onCall` | 需登录：导出本人全部数据（档案、会话、消息）为 JSON，满足隐私合规（§8.1） |
| `deleteAccount` | `onCall` | 需登录：删除账号前先调用 Stripe 取消未到期订阅，随后调用 `admin.auth().deleteUser(uid)` 触发扩展清理 Firestore |

> 注：Stripe Customer Portal 跳转直接复用 `Run Payments with Stripe` 扩展内置的 `ext-firestore-stripe-payments-createPortalLink` Callable 函数，无需自写。

### 4.5 `chat` 流式函数流程

1. `onCallGenkit` 自动校验 Firebase Auth 登录态与 App Check 令牌；用 Zod 校验入参（单条用户消息强制 `z.string().trim().min(1).max(2000)`，防超长上下文注入与 Token 耗尽攻击）；从 token 推导 `tier` 与当前 `periodStart`。
2. 读取 `users/{uid}/sessions/{sessionId}` 与对应 `profiles/{profileId}`，校验归属。
3. 执行 §4.3 的 Firestore 配额事务（超限直接返回 `resource-exhausted`）。
4. 先将本轮用户消息写入 `messages` 子集合。
5. 使用会话文档中已冻结的 `frozenPrompt`（放入独立 `system` 角色指令，与用户输入严格隔离）、`frozenModel` 及 Vertex AI `safetySettings`，注入档案参数与历史消息，仅挂载 `frozenTools` 允许的 `packages/astrology` 纯函数工具，调用 Genkit `generateStream`（单轮最大工具调用步数 `maxTurns: 3`）。
6. 向客户端流式 `sendChunk` 推送文本与工具调用状态；流结束后将完整的 assistant 消息（含文本与工具结果 `parts`）写入 `messages` 子集合，并更新会话 `updatedAt`。

### 4.6 模型接入与 LLM 防注入护栏

- **模型计费与热更新**：
  - 通过 `@genkit-ai/vertexai` 连接 `asia-southeast1` 的 Gemini 模型，直接计入 Google Cloud Billing Account 并自动抵扣赠金 / 积分。
  - 按 §4.7 发布固定版本配置，新会话使用服务端读到的有效版本；上线核验记录实际哈希，不把控制台点击发布等同于所有实例立即生效。
- **LLM 防注入与最小权限护栏（零爆炸半径）**：
  1. **工具零副作用**：暴露给 `ai.defineTool` 的仅限 `packages/astrology` 的 5 个纯数学排盘函数（`natalWheel`、`transitEvents`、`baziPillars`、`ziweiPalaces`、`synastryAspects`），严禁在任何 LLM Tool 中调用 `firebase-admin`、读写数据库、修改配额或访问外部网络（由 `scripts/check-boundaries.mjs` 静态强制检查）。
  2. **输入硬限与步数限制**：单条消息上限 `2000` 字符；`generateStream` 设置 `maxTurns: 3`，防止恶意 Prompt 触发无限工具调用循环。
  3. **指令隔离与防套词**：`frozenPrompt` 必须通过 Genkit `system` 参数下发，禁止与用户输入字符串拼接；每个 Preset 的 System Prompt 末尾统一内置防泄露规则（拒绝复述、翻译或输出系统指令原文）及 Vertex AI `safetySettings`。

---

### 4.7 Prompt 私有仓库与本地 MCP 调优（目标设计，待迁移）

**设计复核（2026-11-15）**：采用“私有 GitHub 保存与展示 → 占星师的 harness 提出修改 → 本地 MCP 执行真实评测 → 审核后发布完整配置”。不建设独立 Prompt 展示站点或编辑后台。GitHub 文件页、README、PR 和 Markdown 报告承担展示；生产继续使用 Genkit 与 Remote Config。本节取代原 Playground 目标设计，§4.7.6 保留既有调优证据。

**实施记录（2026-11-15，迁移第一批，未整体验收）**：统一文本源已落在 `apps/api/prompts/`，构建期使用已装 Genkit Dotprompt 渲染，`npm run prompt:build` 生成固定产物，`npm run prompt:check` 检查漂移；API 构建前强制检查。三档默认 Bundle 与迁移前快照深等价，保留 `consultation-guides-v4`。新增严格完整快照入口与确定性内容哈希，legacy 补默认入口保留给旧会话兼容。

本地五项 MCP 工具及异步任务代码已准备，启动命令 `npm run prompt:mcp`；任务模块已验证串行、快照隔离、取消落盘、重启中断、并发队列上限及路径约束。资源编译拒绝未知变量/helper、缺失/循环片段与额外角色，相关资源/任务测试共 12 项通过。比较暂为固定 A/B 标签、未随机匿名且未分页，属于部分实现。用户随后明确要求实施可分发调优仓库，已安装固定 `@modelcontextprotocol/sdk@1.32.2` 并将其加入 API 依赖白名单；官方 SDK stdio 握手、五工具枚举及初始请求检查已接通。独立调优目录及真实模型验证见下文，目标 harness 的无代码用户验收仍待完成。独立私有调优仓库已创建并交付（见 §4.7.5a）；产品目录完全迁移、完整逐轮请求诊断及测试 Remote Config 发布闭环尚未完成。目录清单当前使用 `manifest.json`，不新增 YAML 解析依赖。

**旧入口删除（2026-11-15）**：负责人明确要求删除旧 Playground，已移除网页/样式、专用 Vite 配置、API HTTP 入口及启动脚本，并停止 4310/4311 的旧服务。浏览器 localStorage 草稿未自动迁移或清除；共享生成函数、案例和评测证据保留。无代码用户验收不因此视为完成。删除后 API 为 2326/3000 行、web 为 5510/5600 行，边界检查通过。

#### 4.7.1 唯一来源与展示

Prompt 私有仓库为 [james-olavai/vela-prompts](https://github.com/james-olavai/vela-prompts)，本地独立目录 `/home/yhvh/code/vela-prompts`。所有可调的模型可见静态文本有唯一源文件；代码仓库消费固定版本的生成产物，不再另维护手写默认值。

```text
vela-prompts/
  README.md                    # 中文入口、产品索引、草稿与线上版本
  manifest.json                # 契约版本、资源 ID、产品及能力映射
  prompts/
    products/*.prompt          # 产品角色、任务、输出文案
    shared/_*.prompt           # 共享片段、消息呈现模板
    references/*.md            # 技法标题、摘要、适用条件、正文
    tools/descriptions.yaml    # 已注册工具的模型可见说明
  cases/                       # 合成星盘、问题、历史、固定参考时间
  reports/                     # 审核后的脱敏比较报告
  releases/                    # 发布清单与环境状态
```

`prompts/` 统一文本来源，不要求所有文件同一格式。主 Prompt、片段优先使用 Genkit Dotprompt；实施前验证锁定版本的渲染、消息角色、工具绑定和打包行为。Dotprompt 支持目录加载、变量与共享片段，继续复用 Genkit，不为模板另加 LangChain。参见 [Genkit Dotprompt](https://genkit.dev/docs/js/dotprompt/)。`.prompt` 可直接查看源码；需要中文阅读摘要时从同一资源生成 Markdown，不手工维护第二份文本。

| 内容 | 管理方式 |
| --- | --- |
| 角色、风格、输出说明、示例、Reference、工具说明、工具返回中的指导文案 | Prompt 仓库，可提交候选修改 |
| 档案/事实/历史呈现模板 | Prompt 仓库；变量、角色和数据边界由代码强制 |
| 安全尾注、事实约束、参数 Schema 内说明 | 代码仓库，只读登记并展示生效版本 |
| 工具实现、路由、权限、校验、配额、步数上限 | 代码仓库，不可由配置覆盖 |
| 档案、用户消息、历史、实际排盘和工具结果 | 运行时数据，展示来源与实际值 |
| 模型与 GitHub 凭据 | 本机凭据系统/环境，不进入仓库、Bundle 或报告 |

每份静态资源登记稳定 ID、版本、来源、可编辑性与引用产品。共享修改列出受影响产品；产品覆盖必须显式声明。模板只允许登记变量和受控 helper，不执行任意代码/网络请求；用户数据不能提升为系统指令。工具名必须已注册，最终工具权限为配置、档位与当轮路由的交集。

第一版使用私有 GitHub 仓库文件页，不启用 GitHub Pages。私有仓库不等于私有 Pages，后者有 Enterprise Cloud 等条件，不能把私有 Prompt 发布到默认公开站点。依据 [GitHub Pages 可见性说明](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/creating-a-github-pages-site)。阅读与审核不需要独立 HTML 服务，执行评测仍需要本地进程。

#### 4.7.2 Bundle、版本与产品契约

继续使用 `PromptBundle` 作为完整运行快照。模板渲染接入共享生成函数，不让 Dotprompt 再开启一套工具循环。产品目录使用稳定 `productId`/商品 slug，与订阅档位分离，声明输入能力、模式、最低档位、资源引用与发布参数键。旧 `preset_${tier}` / `preset_${tier}_${mode}` 使用明确 legacy 映射，不自动猜测产品关系。

每次运行先固化快照，记录 Prompt commit、未提交候选的 diff/内容哈希、runtime commit、schema/runtime contract 版本、产品、完整 Bundle 哈希、资源清单、案例版本、参考时间、请求模型与实际返回模型、有效参数。哈希采用确定性序列化；分支名和人工修订标题不能代替版本。运行中修改文件不影响当前任务。

发布只接受已提交并验证的快照；构建生成完整 Bundle 与同源固定兜底产物，不在用户请求期间拉取 GitHub `main`。未知资源、循环引用、未知/缺失占位符、未注册工具和不兼容运行时必须拒绝，不能悄悄补入当前代码默认值。

新会话冻结完整 Bundle 与哈希到服务端私有子文档，客户端只读版本标识。旧会话使用固定 legacy 默认值并注明来源；代码护栏继续强制生效。模型和算法可能变化，因此配置冻结保证追溯，不保证逐字复现。

新增纯配置产品只需目录、资源、案例及商品上架，MCP 自动发现，不增加产品分支。新增工具、输入类型、输出组件或执行流程仍需代码实现与能力契约更新。

#### 4.7.3 本地 MCP 与占星师流程

第一版由 harness 启动本地 stdio MCP，不监听端口，不新增部署函数或 workspace。工程人员一次性配置私有仓库、运行时、凭据和启动入口；占星师通过自然语言选择产品与案例、描述改进目标。此为现行本地交付方式；远程调优 API 与 Firebase 鉴权的后续设计见 §11，本地能力在迁移验收前继续保留。

GitHub 官方 MCP 或本地 Git 处理文件、分支和 PR；Vela MCP 只处理领域检查与评测，不重复实现 GitHub 客户端，不提供生产发布工具。编辑/评审所用 harness 模型与被测模型分别记录；harness 自己回答星盘问题不能算 Vela 评测。

| 能力 | 契约 |
| --- | --- |
| `inspect_product` | 输入产品、快照及可选案例；返回有效配置、资源/权限、共享影响范围和初始请求预览；注明尚未发生的工具响应 |
| `start_evaluation` | 输入基线/候选快照、案例、模型、重复次数及预算；校验后返回 jobId，异步执行 |
| `get_evaluation` | 输入 jobId 与游标；分页返回进度、回答、依据、用量、错误和报告引用 |
| `cancel_evaluation` | 停止排队项，尽力取消在途请求，保留部分结果与已发生用量 |
| `compare_evaluations` | 输入两次运行 ID；检查可比条件，生成匿名 A/B、硬性失败和人工待评项，不自动宣布优胜 |

使用 Schema 校验，只接受配置目录内的资源引用、登记模型和固定网关；拒绝路径穿越、任意命令和任意 URL。协议 stdout 不输出日志。任务保存在本地忽略目录，状态为 queued/running/completed/failed/cancelled/interrupted；重启后未完成任务记 interrupted，不自动重复计费。设置案例数、重复次数、并发、输出 token、轮数和超时硬上限；价格未知时不承诺精确货币预算。trace 按需分页读取，避免一次占满 harness 上下文。

占星师流程：“用北京案例测试这个问题 → 回答太迎合，请提出改法 → 看修改摘要和影响产品 → 比较回答与依据 → 填写偏好和原因 → 保存候选并交付 PR”。显示中文业务名称、版本状态和可行动错误，无需编辑 JSON、终端操作或 Firebase Console。必须由无代码占星师在实际 harness 完成一次验收，不能仅凭 MCP 已接通就认定可用。

README 区分“线上已发布”“已合并待发布”“本地候选”，链接对应资源和报告。线上记录环境、运行时、Remote Config 版本与 Bundle 哈希；以线上核验为准，不把 README 的自述当实际状态。

#### 4.7.4 真实上下文、评测与发布

生产与 MCP 复用同一生成函数：路由、事实、组装、工具调用和后处理一致；入口仅分别负责认证/配额或本地输入。MCP 不访问生产用户数据，也不绕过生产输入和工具权限规则。

自动注入与 `loadSkillReference` 均读取本轮不可变 Bundle，工具说明按次绑定，禁止修改全局目录。记录每轮真正送入模型的消息、工具说明/Schema、工具输入输出与 Reference 版本，区分可用、自动注入、工具加载、未加载。文件页不是完整上下文，初始请求预览也不代表后续工具响应。分别保留流式片段、原始输出、护栏处理和最终回答。

保留 A/B/C 合成档案、合盘、迁移和多轮案例，不依赖相邻 `code/vela`。独立天文黄金集验证算法；固定工具结果隔离 Prompt 变化；真实工具端到端验证链路。引擎自产结果不能称为独立黄金值。fixture 按工具名与规范化参数匹配，未命中失败；Reference 始终读取候选配置。保留 §4.7.6 的返照已知错误，不通过 Prompt 掩盖算法问题。

A/B 固定资料、问题、历史、参考时间、运行时、模型及工具模式，交替顺序并按需要重复；Prompt 与模型参数变更分开比较。条件不一致只能做描述性比较。未知用量/价格标记未知，不支持的参数明确报错或标记未生效。Hydrogen 不支持温度，本地 16K 成功不能替代生产预算验证。

人工评审关注直答核心、指出有依据的盲区而不读心、客观呈现两面与现实限制、普通语言、自主安全且不责怪用户的积极行动。编造事实、不当确定性、危险建议不得由文风高分抵消。可以让独立 harness/评审者盲评，最终保留人的判断。已多轮调过的案例属于回归集；发布前另用未参与优化的保留案例验证，不能宣称统计显著优胜。

原始 trace 默认留本地；只有审核过的脱敏报告和必要复现清单进入私有 Git。真实个人档案与凭据不进入评测仓库。

发布链路：候选 PR → 契约/案例/质量审核 → 固定 commit 的完整 Bundle → 测试 Remote Config → 新旧会话与回滚验证 → 工程人员生产发布 → 核验生效哈希。合并 PR 不自动上线。Remote Config 是发布载体，Git 是日常编辑源；紧急控制台修改必须记录并回填 Git，未消除漂移前阻止覆盖发布。

发布前检查当前运行时兼容性和 Remote Config 参数/模板容量限制，相关配置作为同一完整模板版本发布。Bundle 超限应阻止发布，改为随部署打包固定资源并重新评审，不临时拆分造成混合版本，不新增存储平台。拉取失败只回退固定已验证默认值并记录原因/来源。回滚恢复上一完整兼容 Bundle，新会话采用回滚值，旧会话保持冻结值。

#### 4.7.5 迁移顺序与验收

1. 盘点全部静态指导文本及只读规则，建立私有目录；保留 `consultation-guides-v4` 与五轮评测证据。验证模板迁移前后有效消息、Reference、工具权限和输出规则一致。
2. 接通固定版本编译、产品目录、legacy 映射及运行时兼容检查；验证非法变量/工具与并发隔离。
3. 实现本地 MCP 检查、异步评测、取消、比较与报告，复用已有运行器，不新增另一套生成链路。
4. 无代码占星师在实际 harness 完成修改、比较、依据查看和 PR 交付；验证失败、取消、重启中断及预算限制。
5. 在测试环境验证发布哈希、新旧会话冻结和回滚；Git 不可用不影响生产，未发布草稿不能流入生产。
6. 旧 UI、HTML 入口、专用 HTTP 服务及启动脚本已按负责人后续指令删除；保留案例与历史证据，浏览器旧草稿未迁移。生产构建排除 MCP、评测档案与本地凭据逻辑；工程 Genkit 诊断保留。

验收还包括：纯配置产品无须改 MCP 分支；共享资源影响范围可追踪；所有模型可见指导文本可溯源；配置不能移除护栏/扩大权限；相关测试、类型检查及 `npm run check` 通过。旧 UI 删除后已回到现有预算，旧工作台前端扩容申请撤销。

不在本次设计更新中修改 `boundaries.json`。MCP 采用现成协议实现，不手写协议；若已安装依赖不够，按 §6 申请最小 SDK 依赖变更，经负责人批准再实施。本地 stdio 不等于对外 Remote MCP，不占生产函数名额。

#### 4.7.5a 可分发调优工作区

工程人员运行 `npm run tuning:pack` 生成 `.playground/vela-tuning/`，或用 `-- --output <新目录>` 指定位置；拒绝覆盖已存在目录，避免误删用户修改与评测结果。目录可作为独立私有 Git 仓库内容，包含 `prompts/`、合成 `cases/`、中文 README、模型凭据示例、MCP 接入入口与固定 `runtime/`，无须克隆整个应用仓库。

用户在独立目录 `npm ci` 后执行 `npm run setup`，将生成的本机 MCP 配置加入自己的 harness；移动目录后重新 setup。模型网关地址和凭据放本机 `.env` 或 harness 环境变量，不随分发包复制。MCP 在本地调用打包的共享 Vela 生成链路，不连接生产 Firebase；当前适配器仅支持 Hydrogen，harness 只负责修改与辅助评审，被测回答来自目标模型。

`runtime.lock.json` 固定运行时来源 commit、实际源码哈希、能力契约、依赖确切版本和初始 Prompt 来源哈希；未提交代码以源码哈希补充来源，不能冒称 HEAD 的原样发布。完整性清单检查运行时代码及初始案例，Prompt/报告允许调优修改；运行时升级需重新交付兼容包，不运行时拉取最新代码。包内锁文件支持独立安装，禁止复制 node_modules、凭据、原始 trace 或真实用户档案。

独立模式每次检查/评测编译本目录当前 Prompt，路由指导文字、技法摘要和工具描述按运行快照注入；已启动任务不受后续文件修改影响。任务与原始结果写入忽略的 `.vela/`。候选仍经 PR 与目标模型回归后才发布；随后按负责人要求创建并推送独立私库 `james-olavai/vela-prompts`；本批未发布生产，旧 Playground 已按负责人后续指令移除。

**独立目录验证（2026-11-15）**：从生成目录独立 `npm ci`，官方 SDK Client 经 stdio 枚举五工具，检查/修改 Prompt 后即时反映且主项目默认值不变；使用本机网关凭据完成一次 Hydrogen 案例，返回 453 字、两轮响应均报告 `gemini-4-hydrogen`。任务查询、比较及排队取消通过。安装脚本修订后另外复验最终包的 setup/verify/协议；原始模型证据留本地，不随包发布。这是工程接入验证，不代替无代码占星师验收或生产预算测试。

**harness 交接入口**：独立仓库根 `AGENTS.md` 说明资源职责、固定运行时、凭据边界及候选/部署区别，小写 `agent.md` 仅链接同一规则。`.agents/skills/vela-prompt-tuning/SKILL.md` 指导产品/案例发现、建立基线、文本修改、目标模型评测、人工比较与脱敏报告；不支持 skill 自动发现的 harness 可直接按路径读取。打包脚本从 `scripts/tuning-assets/` 复制这些入口，后续重新交付不会丢失。skill 已通过 skill-creator 校验，独立目录安装、setup、校验和官方 SDK 冒烟检查通过。

#### 4.7.6 默认技法与咨询规范调校（2026-11-15）

默认版本升级为 `consultation-guides-v2`，保存于仓库默认配置，供生产默认回退与工作台使用。参考旧 `code/vela/vela-agent/backend/app/domain/services/natal_prompt_service.py` 及 `product-presets/standard-v1/{professional,quick,life_coach,master}.json`，充实九类技法指南。不存在完整旧指南的部分按当前工具真实输出范围编写，明确层级、日期、相位和跨体系口径限制，不将象征解释冒充确定预测。

随后升级至 `consultation-guides-v3`：同步全部 35 项工具说明，说明适用问题、必需资料、实际返回内容及不能据此推断的事项。逐项按当前 TypeScript Schema/实现核对；特别注明小限仅年度、黄道释放仅 L1、法达年龄近似、八字大运兜底与合盘无法判断他人内心等局限。默认工具注册和工作台读取同一份说明，旧草稿仍需显式载入新版默认配置。

咨询规范：先回应核心问题，再说明支持依据、限制和用户可能忽略的预设；理解感受但不迎合未经证实的结论，不猜测他人动机；术语仅保留少量并立即解释现实含义；同一倾向说明适用情境与过度使用的代价；提出本人可执行、可观察的行动，不强行积极、不归责受伤者。占星解释不能保证结果，也不作为现实事件或心理诊断的证据。

普通咨询按当轮开放技法直接注入相关指南，深度模式仍可通过工具加载。`diagnostics.loadedReferences` 记录正文、版本及 `auto/tool` 来源；工作台“本次依据”以可读方式展示。只含西占的路由不注入中西合参指南。旧浏览器草稿不自动覆盖，点击“载入新版默认配置”确认后使用新版本。

**Hydrogen 生产传输**：`@genkit-ai/google-genai` 固定为 `1.42.0`，使用 Vertex global 的 `streamGenerateContent`。1.43+ 将 Hydrogen 默认路由至 `/interactions`，2026-11-15 使用旧会话配置与独立合成档案复现持续 429；同模型 `generateContent` 请求成功。升级前必须通过真实 SDK 的端点、流式工具调用及 thought signature 回传回归。上游错误记录状态与截断后的服务错误信息，不记录用户输入或凭据。

**Hydrogen 参数限制**：依据 [Google 官方 Hydrogen 指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen)，服务端忽略自定义 `temperature/top_k/top_p`。保存温度字段供其他模型使用；Hydrogen 请求不发送该字段，界面禁用温度编辑并显示模型默认行为，诊断明确 requested 与 effective 的区别。不能将 Hydrogen 两次输出差异解释为温度优化效果。

**A/B 资源与执行**：`ab-baseline.json` 保留提交 `1a6864c` 的旧 Go Bundle，仅作历史资源，并非后续各轮基线。`ab-cases.json` 包含六类咨询问题（迎合、直答、人话、宿命、他人动机、资源与代价）。当前运行器使用 `npm run prompt:ab -- --baseline <完整配置.json> --candidate <完整配置.json> --cases <案例目录.json> --tier go --repeats 1 --max-output-tokens 16384 --output <本地结果.json>`，会真实调用模型，需本机 `.env` 的 `llm_gateway_token` 或环境变量 `LLM_GATEWAY_TOKEN`；令牌仅留服务端，不进入结果。两臂交替顺序，同一模型、资料、工具及采样行为；不自动宣布优胜。

**2026-11-15 选择记录**：初次 Vertex AI 尝试因缺少身份验证失败，之后经负责人配置的 `http://192.168.8.10:8088/v1` 网关实际调用 `gemini-4-hydrogen`。主协调者裁决，独立子代理使用匿名回答与计算结果复核；运行方知版本，评审不读取映射，但文风与长度仍可能暴露版本，不能视为严格双盲试验。

| 轮次 | 基线 / 候选 | 回答数 | 结论与限制 |
| --- | --- | --- | --- |
| R1 | 默认 v3 / direct-human-r1 | 12 | 短段落更易读但仍迎合、术语多；旧工具 Schema 链，仅探索性 |
| R2 | 默认 v3 / direct-human-r2 | 12 | 增加篇幅限制，出现边界对抗测试与心理因果回归；旧 Schema，仅探索性，不采用 |
| R3 | 默认 v3 / direct-human-r2 | 8 | 修复工具 Schema 后复核，仍有将行运写成现实原因的问题，不采用 |
| R4 | direct-human-r2 / direct-human-r3 | 12 | 安全自主与符号解释改善，但新题仍有主动预测和小动作诊断成因；不直接采用 |
| R5 | direct-human-r3 / direct-human-r4 | 8 | 进一步禁止未询问的预测与诊断式小测试；主裁判及独立评审逐题均有限偏好第四候选，选作本地默认 v4 |

五轮共 52 份完整回答，响应均报告 Hydrogen；无替代模型，无自定义温度。主裁判选择不是按总分抵消事实或行动底线：前几版即使更短，也因具体回归被退回。完整证据与配置见 `apps/api/playground-fixtures/hydrogen-evaluation-2026-11-15.json`。这不是统计显著性或占星预测有效性证明；主要对比使用合成档案 A、Go 档位，其他星盘与产品未完整 A/B。依然存在心理倾向推论过强、条件性决策不够明确及个别术语/能力背书的问题，需要持续抽查。

**默认与运行边界**：`consultation-guides-v4` 的 Go 主 Prompt/输出指令与获选第四候选逐字一致；Free/Pro 复用表达规范、调整角色，保留权限，仅另作冒烟验证。旧草稿需显式载入新版默认，已有生产冻结会话不变；本轮未发布 Remote Config 或生产函数。Hydrogen 的 4096 输出预算曾产生思考耗尽、空文本截断；本地网关及评测明确使用 16384 并记录实际预算，生产额度仍按既有配置，不能把本地成功当作生产预算已验证。

**配套修复**：Zod4 技法 Schema 改为明确 JSON Schema 传给 Genkit，并用原 Schema 校验/补默认值，避免参数定义为空、将 `months` 猜成有效窗口。独立模型请求捕获测试及真实行运 `windowMonths:3` 已验证。减少裸“机会 / 最近 / 工作才半年”等叙述误触发行运，明确“未来半年 / 最近运势”等仍可用；路由修复的贡献单独记录，不归入 Prompt 胜负。R5 运行时的裸“半年”缺口随后修复，最终候选单臂领导题验证仅开放并调用 `natalWheel`，不再主动加入时间工具。既有 Pro 深度模式默认扩展工具逻辑仍保留，不声称已实现完整语义路由。

---

## 5. `apps/web`（前端）

前端为托管在 Firebase Hosting 上的 React + Vite 单页应用，复用 `../vela/frontend-v2` 的视觉与组件，数据层完全基于 Firebase Web SDK（模块化 v10+）重写：

| 部分 | 处理 |
| --- | --- |
| UI 组件、样式、`@assistant-ui/react` 界面（非 admin 部分约 4200 行 TSX） | 保留；移除旧的 `R1*` 强耦合 props |
| 登录与会话 | `firebase/auth`（`signInWithPopup` Google OAuth + 邮箱密码/免密链接登录），监听 `onIdTokenChanged` 获取 `stripeRole` |
| 档案、商品目录、会话列表、消息历史读取 | `firebase/firestore`（`onSnapshot` / `getDocs`），利用离线缓存与实时更新，省去手写 REST API 调用 |
| 流式对话对接 | 使用 `@assistant-ui/react` 的 Custom / Local Runtime 包装 `httpsCallable(functions, 'chat').stream()` |
| 订阅与账单管理 | 往 `customers/{uid}/checkout_sessions` 写文档触发 Stripe Checkout；调扩展 `createPortalLink` 打开 Customer Portal |
| 站点分析与漏斗 | `firebase/analytics`（GA4）+ Google Consent Mode v2（默认 `analytics_storage: 'denied'`，用户点击底部同意条后切为 `'granted'`） |
| 类型与校验 | 从 `packages/shared` 导入共享的 Zod schema 与配额常量 |
| 新增合规界面 | 页脚隐私政策 / 服务条款链接、底部统计同意条、注册满 18 岁勾选、AI 生成内容与占星免责提示、账号设置里的「导出数据」「删除账号」 |

---

## 6. 推迟项（出现具体需求再做）

| 项 | 触发条件 | 做法 |
| --- | --- | --- |
| 统一业务与 Prompt 调优 OpenAPI（2026-11-16 设计确认，待实施） | 真实用户 Token 的业务 E2E 与统一调优调用需求已明确；现有直连 Firestore、Callable 与本地 MCP 不能提供统一业务契约 | 按 §11 分阶段迁移；负责人已允许突破六个函数上限，实施时调整实际函数清单与机器边界；该授权不自动扩大其他依赖、平台和行数预算 |
| 定制化运营后台 UI | Firebase Console + Stripe Dashboard 无法满足非技术运营的日常操作 | 优先接 Rowy / Retool 直连 Firestore；或新增受 `admin: true` Claim 保护的轻量管理页 |
| Google Cloud Model Armor | 线上出现针对 System Prompt 的高频越狱/套词攻击 | 在 `chat` 入口挂载 Google Cloud Model Armor API（前 200 万 Token/月免费，超出 $0.10/M Tokens）做输入/输出双向扫描 |
| 其余排盘技法 | 某个商品需要 | 从 `chart.py` / `astrology_methods.py` 移植到 `packages/astrology`，以对应黄金用例验收 |
| 对外 Remote MCP | 本地 stdio 无法满足明确的远程多人需求 | 远程调优 HTTP API 已纳入 §11，函数数量扩展已获负责人授权；部署 Remote MCP 服务本身仍需单独确定，本地 MCP 可先作为 API 客户端 |
| 第三方社交与开发者平台 SSO（GitHub / Discord / Microsoft / X (Twitter)） | Google + 邮箱登录外，出现明显的开发者/社群/企业单点登录需求 | 在对应第三方开发者后台申请 Client ID & Secret 填入 Firebase Auth，前端在 `AuthGateModal` 增加对应 `OAuthProvider` 按钮 |
| `apps/web` 行数预算上调至 `5600`（原 `5000`）+ `qrcode` | 1:1 完整迁移旧 Vela 能量画像（含日历联动即时天象轮、洞察卡、元素特质、年度能量窗口）与带二维码分享海报 | 负责人批准后同步更新 `boundaries.json` |
| 全量 34 个排盘工具 + `loadSkillReference`（`maxAstrologyTools: 35`） | 先补齐原 `vela` 全部 34 项占星/命理算法，再配合推演深度、智能路由与 Reference 渐进式披露 | `boundaries.json` 同步上调 `packages/astrology`、`packages/shared` 与 `apps/api` 行数与工具上限 |
| 旧工作台前端扩容申请（已撤销） | 目标已改为 §4.7 私有 GitHub + harness + 本地 MCP | 旧 UI 已按负责人要求删除，不扩大原有前端行数预算 |
| 本地 MCP 官方 SDK（2026-11-15 已按用户实施指令接入） | 已安装依赖不能提供 stdio MCP 能力，用户明确要求实施独立调优库 | API 增加固定 `@modelcontextprotocol/sdk@1.32.2` 及依赖白名单，不增加 workspace、部署函数或代码行数预算 |
| LLM 回复 Markdown（2026-11-15 按用户确认的实施方案接入） | 正则渲染无法覆盖列表、GFM 表格、引用与代码块；现有 assistant-ui Markdown 组件需要另接会话运行时 | 前端增加固定 `react-markdown@10.1.0` 与 `remark-gfm@4.0.1`，同步依赖白名单；按需加载独立渲染组件，关闭原始 HTML、过滤链接协议并将模型图片降级为替代文字，不增加运行时、UI 框架或行数预算 |

---

## 7. 待决策项

1. **Gemini 具体生产型号（阻塞上线，不阻塞开发）**：架构已统一为 Google Cloud Vertex AI（处理方已固定为 Google，不再新增第三方模型处理方，大幅简化隐私政策 §8.2）。Phase 0 需在 Vertex AI 上的候选 Gemini Flash / Pro 型号间用 3 个 Preset 实测对比解读质量、工具调用稳定性与单次 token 成本，定下 Remote Config 中的默认型号。
2. **界面与 Prompt 语言**：现有 Preset 是中文。面向海外华人可直接复用；面向英语用户需要在 Remote Config 中配置英文版 Prompt 并做前端 i18n，不在第一阶段范围内。

---

## 8. 合规（海外上线）

以下是工程视角的清单，不是法律意见；隐私政策与服务条款的文本上线前应由律师审阅。

### 8.1 需要写代码的

| 项 | 做法 |
| --- | --- |
| 删除账号 | 前端调用 `deleteAccount` 函数：先通过 Stripe SDK 取消该用户的活跃订阅，再删除 Firebase Auth 用户，由 `Delete User Data` 扩展自动清除 `users/{uid}`、`usage/{uid}`、`customers/{uid}` 下所有文档 |
| 数据导出 | 调用 `exportUserData` 函数，打包本人档案、会话、消息返回 JSON 下载 |
| 删除单个档案与会话 | 客户端直接调用 Firestore `deleteDoc`（删会话时通过触发器或服务端批量清理子集合 `messages`） |
| AI 提示 | 对话界面明确标注内容由 AI 生成 |
| 占星免责 | 页脚与首次对话前提示：内容仅供娱乐与自我探索，不构成医疗、法律、财务或心理健康建议。同一句写进每个 Preset 的 system prompt |
| 年龄确认 | 首次登录初始化 `users/{uid}` 时必须勾选确认已满 18 岁并同意条款，记录 `confirmedAdultAt` 时间戳 |
| 法律页面 | `/privacy`、`/terms` 两个静态页，页脚与登录弹窗链接 |

### 8.2 需要写进隐私政策的

- **收集的数据**：Google 账号的邮箱、姓名与 UID；用户填写的出生时间、出生地、性别（含亲友档案）；对话内容；Stripe 订阅状态；匿名或经同意的站点使用统计（Firebase Analytics）。不存储支付卡号。
- **处理方清单**：Google Cloud / Firebase（托管、Firestore 数据库、身份认证、Remote Config、App Check、Analytics、Vertex AI 模型推理，主区域 `asia-southeast1`）、Stripe（支付）、Open-Meteo（城市解析，仅发送地名查询，不带用户标识）。
- **数据使用说明**：明确使用的是 **Google Cloud Vertex AI 付费企业级服务**，根据 Google Cloud 数据处理附录（CDPA），用户输入的出生信息与对话内容**不会被 Google 用于训练基础模型**。
- **跨境传输**：数据存储与计算位于新加坡（`asia-southeast1`），面向欧盟/英国或其它地区用户时按 Google Cloud 标准合同条款（SCCs）披露。
- **保留期限**：账号数据保留到用户主动删除为止；Cloud Logging 日志保留期设为 30 天。
- **用户权利与亲友档案**：说明访问、导出、删除方式；用户录入他人出生信息时，由用户承诺已获对方同意，写入服务条款。

### 8.3 Stripe 与订阅

- 启用 Stripe Tax，由 Checkout 自动计算并代收增值税/销售税。
- Checkout 开启「同意服务条款」勾选，并链接到 `/terms`。
- 服务条款写明自动续订、取消方式（Customer Portal）与退款政策（含欧盟 14 天撤回权豁免同意）。

### 8.4 Cookie 与 Consent Mode v2

前端启用 `firebase/analytics`（GA4）时，初始化默认调用 `setConsent({ analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })`。仅在用户点击底部同意横幅后将 `analytics_storage` 设为 `'granted'`，满足欧盟 GDPR / ePrivacy 要求。

### 8.5 上线检查清单

- [ ] Swiss Ephemeris Professional License 已付款并收到会签件（§3.4）
- [ ] Google Cloud 计费账户已绑定，赠金/积分已激活生效，且设置了预算告警（Budget Alerts）
- [ ] Firebase Remote Config (Server) 已发布 3 个 Preset 的生产配置，Firestore `products` 集合已上架对应卡片（§4.1、§7）
- [ ] Firestore Security Rules 已通过模拟器单元测试并部署，确认客户端无法直接写 `usage`、`messages`、`products`
- [ ] LLM 防注入护栏已验证：`chat` 单条消息 `<= 2000` 字、`maxTurns: 3`、Tool 无数据库/网络权限、System Prompt 含防套词指令与 `safetySettings`
- [ ] Firebase App Check（reCAPTCHA Enterprise）已在生产环境开启 `enforceAppCheck: true`
- [ ] `Run Payments with Stripe` 与 `Delete User Data` 两个扩展已安装并实测通过（测试模式下完成升级、续订、取消、删号全链路）
- [ ] 隐私政策、服务条款已由律师审阅并上线，GA4 Consent Mode v2 横幅验证生效
- [ ] Stripe Tax 已启用，Checkout 带条款勾选
- [ ] Cloud Logging 保留期已设为 30 天，自定义域名已绑定到 Firebase Hosting

---

## 9. 实施顺序与工期

按纵向切片推进：先打通一条最细的端到端链路，再逐步加宽。工期为一人全职的粗略估算，合计约 5 周。

| 阶段 | 估算 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| **Phase 0 风险验证** | 3 天 | 切换脚手架与 `boundaries.json` 至 Firebase 架构；§3.3 的三项验证；导出东占基准（§3.2）；Genkit `onCallGenkit` 流式桩对接前端 `@assistant-ui/react`；Vertex AI Gemini 型号对比（§7） | `natal_A` 在 Functions 内算出且与黄金集一致；前端桩页面能显示 Genkit 流式回复；定下默认 Gemini 型号 |
| **切片 1：最细链路** | 1 周 | Firebase Auth Google 登录 → 建一个档案 → `createSession`（读 Remote Config Server 模板） → `chat` 调用 `natalWheel` 一轮对话 → 前端显示。含 Firestore Rules 与模拟器配置 | 本地 Emulator 与线上 `asia-southeast1` 预览环境都能走通全流程 |
| **切片 2：排盘与预设补全** | 1 周 | 其余 3 个排盘工具；§3.2 的西占与东占用例全部通过；3 个 Preset 写入 Remote Config Server 与 `products` 集合；会话列表与历史实时读取 | 排盘回归测试全绿；3 个 Preset 可在前端发起完整对话 |
| **切片 3：配额与订阅** | 1 周 | §4.3 Firestore 配额事务与并发测试；配置 `Run Payments with Stripe` 扩展；前端接入 Checkout 与 Customer Portal | 配额模拟器测试通过；Stripe 测试模式下完成升级（`stripeRole` 生效）、续订、取消 |
| **切片 4：前端补全与合规** | 1 周 | 档案管理、商品目录、城市搜索（`resolveLocation`）、排盘事实展示组件；GA4 Consent Mode v2；导出数据（`exportUserData`）与删除账号（`deleteAccount` + `Delete User Data` 扩展） | `docs/DESIGN.md` §2 的页面全部可用，删号与导出实测通过 |
| **上线准备** | 3 天 | 开启 App Check 强制校验；完成 §8.5 检查清单 | 清单全部勾完 |

### 9.1 架构与代码审查整改（2026-11-15）

以下事项纳入现有切片，按风险顺序推进；沿用上述阶段截止日期，不单独估算日期。不得提前执行当前阶段之外的工作。

| 优先级 | 阶段 | 任务与范围 | 验收条件 | 状态 |
| --- | --- | --- | --- | --- |
| P1 | 切片 3 | 修复并发配额检查：模型调用前原子预留额度（`reserveQuota`，含 120s TTL 自动清理过期在途预留），完成后按实际费用结算（`settleQuota`），失败释放预留（`releaseQuota`） | Emulator 测试覆盖同一用户并发、超限、失败释放、TTL 过期清理和跨周期；并发请求不能绕过额度门槛 | 已完成（`apps/api/src/quota.ts`） |
| P1 | 切片 4 | 修复删号与订阅取消：缺少 Stripe 配置或取消失败时在 `users/{uid}.deletionState` 保留可重试状态，不报告删除成功；订阅全部取消后再删除 Auth 与 `users`/`usage`/`customers` | 模拟器测试覆盖无密钥拦截、部分订阅取消失败保留状态及重试成功删除，确认不会留下用户无法管理的有效订阅 | 已完成（`apps/api/src/account.ts`） |
| P2 | 切片 2 | 修复长对话上下文：按 `createdAt desc limit(20)` 选取最近 20 条消息并恢复时间正序送入模型 | 超过 20 条消息的会话包含最新 20 条消息、排除较早消息，顺序正确 | 已完成（`apps/api/src/session.ts`） |
| P2 | 切片 2 | 保证编辑上一轮与消息落库的一致性：通过单会话互斥锁（`activeTurnId`）拦截并发请求；生成失败不删原消息、不写半轮消息；生成成功后单事务原子提交替换与新消息 | 生成失败不丢失原对话；成功时替换和新一轮完整提交；并发情况下返回 `SESSION_BUSY` 不交错或误删 | 已完成（`apps/api/src/session.ts`） |
| P2 | 切片 3 | 加固分享奖励：产品规则明确为完成保存海报/复制链接/系统分享动作后解锁领取（记录 `lastShareMethod`）；服务端事务与 `firestore.rules`（基于 `request.time`）双重校验可信 UTC 日期、每日 1 次及每周期 3 次上限 | 模拟器覆盖伪造日期、同日并发领取、每日及周期上限和跨周期重置；奖励规则与产品行为一致 | 已完成（`apps/api/src/quota.ts`、`firestore.rules`） |
| P3 | 切片 4 | 按会话、档案、用量及账号生命周期拆分职责：API 拆分为 `quota.ts`、`session.ts`、`account.ts`；Web 存储层拆分为 `profileStore.ts`、`sessionStore.ts`、`usageStore.ts`、`accountStore.ts`，抽离 `WorkbenchSidebar.tsx` | 相关职责边界清晰，现有用户流程、代码行数预算（`npm run check`）、类型检查与构建全部通过 | 已完成 |
| P1 | 切片 2 | 核查共享 Placidus 宫头计算：Hydrogen 评测中的太阳返照输入可复现宫头非环向顺序，第一宫跨度约 355.85°、十二宫正向跨度合计 1080°，导致全部星点落第一宫；核查其他使用共享函数的轮盘 | 使用独立天文黄金集复核该准确输入及南北半球/跨午夜用例，宫头几何有效且宫位与独立结果一致；不能用排序/交换宫头或自身重放冒充公式修复 | 待修复（本轮未修改算法；两臂正文均未引用异常返照结果） |

返照异常的准确输入和已观察到的错误几何存于 `apps/api/playground-fixtures/known-issues/solar-return-geometry.json`，明确标记为已知失败样本，不作为正确天文黄金值。

**补充约定**：
- **流式响应失败行为**：模型流式生成中途抛错或中断时，服务端回滚会话锁（`releaseSessionTurn`）与配额预留（`releaseQuota`），不删除上一轮消息、不写入半轮消息；前端捕获异常后将乐观消息列表恢复为调用前快照（`existingMessages`）。
- **分享奖励验证规则**：Web 端第三方社交平台无分享完成回调，产品采用「触发保存海报 / 复制分享文案 / 系统原生分享后解锁领取」的自助激励机制（记录 `lastShareMethod: 'native' | 'poster' | 'copy'`），由服务端可信时间事务与 `firestore.rules`（`request.time`）严格限制每日 1 次、每自然月最多 3 次。


## 10. CI/CD 与发布验收

### 10.1 现行流程与验证证据

Gitea 是发布入口，GitHub 同步代码。每次 main/PR/tag 提交运行 `ci`：固定 Node 22.23.2、Firebase CLI 15.36.0、Playwright Core 1.62.1；使用 `npm ci`，完成边界/类型、单元及传输契约、Prompt/MCP、真实 Auth + Firestore Emulator 的 Rules 与并发事务、浏览器回归及双端构建。浏览器工具安装在 Runner 临时目录，不依赖相邻项目；UI 数据明确使用 mock，不作为真实模型可用性证据。独立调优包的 `test:tuning` 需要指定交付目录，不以默认跳过冒充本项目 CI 检查。

CI 生成 `release-<SHA>` 产物，内含预编译 API、同次构建的前端、实际应用命名数据库的规则配置、按本次已安装版本固定的 API 依赖及独立 lock、逐文件 SHA256 清单和版本文件。生成器拒绝解析出根 lock 中不存在的依赖版本。部署直接使用该产物，不重新编译前端/API；云端按包内 lock 安装。

生产发布仅由 v* tag 或 main 上显式 workflow_dispatch 触发，必须依赖 `ci` 成功。缺少 `FIREBASE_SERVICE_ACCOUNT` 立即失败；先用候选代码、相同 Vertex 模型及旧冻结 Bundle 进行真实模型验证，失败不执行部署。发布前按显式函数清单保存 Vela Functions 的源存档引用、Hosting 版本及应用命名数据库 Ruleset；不操作同项目内其他应用或 Storage 规则。更新 Functions/Hosting/Firestore Rules 后，校验线上 SHA/资源，并用自动创建和清理的合成账号验证正常免费咨询、旧冻结配置的超预算无限账号、真实额度用尽拒绝；检查流式正文、done、最终结果、消息落库、用量结算、预留释放及会话解锁。HTTP 200 或静态首页可访问均不算聊天成功。

部署或线上验证失败时，尝试恢复上述三类版本，等待 Functions 恢复操作完成；即使某类恢复失败也继续尝试其他服务，并以失败退出、保留恢复快照及验证证据。`npm test` 覆盖 SSE 假成功、流式错误及部分回滚失败。回滚脚本不修改用户业务数据；数据库结构破坏性迁移不属于这条自动恢复路径。

发布身份为 `vela-ci-deployer@yhvhchen-387212.iam.gserviceaccount.com`，用于部署、模型验证及合成账号数据清理；runtime 的 actAs 权限单独限定在当前运行服务账号。私钥只保存在 Gitea Secret，执行时写入权限 0600 的 Runner 临时文件，EXIT 清理，不进入日志和产物。更新版本前先在 PR 验证契约与实际模型，禁止依赖浮动 CLI 或手动绕过 CI 发布。main 通过 Gitea 分支保护要求 PR CI 成功，禁止直接推送。

发布门槛首轮实测在部署前拦截了模型空正文；候选模型的正文长度、原始正文长度、用量和输出预算在断言前写入脱敏证据，失败也保留记录。该故障不通过缩小问题、降低断言或增加隐式重试绕过。

**生产预算调整（2026-11-15，负责人确认提高）**：Free、Go、Pro 的 `maxOutputTokens` 统一提高至 16384，包含思考与正文。真实发布门槛曾复现 4096 上限中 4093 用于思考、正文为 0、`finishReason=length`。月度费用额度保持不变，继续按实际输入、正文与思考 token 结算，因此可用咨询次数可能减少；无限额度覆盖保留。通过真实生成调用的三档参数契约、相同问题与旧冻结配置的发布前验证和部署后合成账号验证验收，不降低成功标准。

**Vertex 工具 Schema 兼容（2026-11-16）**：数字 literal union 经 Zod4 输出为无顶层 type 的 anyOf；固定版 Vertex SDK 会丢弃这类属性但保留 required，导致行运工具 windowMonths 的 HTTP 400。JSON Schema 导出时给同类型数字常量联合补显式 number 类型与允许值说明，保留原 anyOf 和 Zod 运行时的 3/6/12 校验，不将数字枚举改成字符串。CI 在真实 SDK 最终 HTTP 载荷中检查全部 35 个生产动态工具的 required/properties 一致性及属性不丢失，并执行携带 thought signature 的行运工具往返；发布前及上线后旧冻结无限账号用显式行运问题实际调用 transitEvents。单纯检查 Genkit 转换前 Schema 或仅本命问题通过，不代表行运链路已验收。



### 10.2 统一 API 后的 CI/CD 门禁（目标流程，待实施）

本节配合 §11 分阶段启用；现行流程见 §10.1。新增契约和接口只有接入对应测试、发布清单并通过验收，才算完成迁移；文档存在不表示流水线已实现。Gitea 继续作为 CI/CD 入口，GitHub 同步代码，main 保持 PR 与成功检查保护。

| 阶段 | 必须验证的内容 | 失败处理 |
| --- | --- | --- |
| PR：契约与构建 | 从共享 Schema/路由生成 OpenAPI 与客户端类型，检查生成漂移；与已发布契约比较删除路由、必填参数、类型、错误和事件等破坏性变化；完成类型、边界、依赖锁及前后端构建检查 | 阻止合并；破坏性变化须采用新版本或明确的兼容迁移，不能直接更新基线掩盖 |
| PR：用户 API 集成 | Auth、Functions、Firestore 模拟器运行真实 API，以用户 Token 验证档案、会话、消息、额度、参数、分页、归属、幂等和并发；管理员仅准备特殊条件与清理 | 阻止合并 |
| PR：流式与调优 | 检查真实 HTTP/SSE 序列化、分片与中途错误、断线查询、取消竞争、结算恢复；检查调优权限、不可变版本、任务状态及恢复；保留 SDK 最终模型请求 Schema 检查 | 阻止合并 |
| PR：浏览器集成 | 浏览器建立真实模拟器登录态并调用本地实际 API，模型使用受控桩；验证建档、咨询、流式显示、刷新恢复、错误与重试 | 阻止合并；独立 mock UI 回归可保留，但不能替代此链路 |
| 发布前 | 使用通过 CI 的固定产物，验证候选代码与真实 Vertex、本命与行运工具、旧冻结配置和有效正文；验证新后端兼容受支持的旧客户端 | 阻止部署；普通 PR 不调用付费模型，真实模型检查在受信任发布环境运行 |
| 部署后 | 核对源码/契约版本；合成账号使用用户 API 完成建档、排盘、咨询、查询消息和额度，覆盖普通、无限与额度用尽状态，检查终态、结算及锁释放 | 标记发布失败，按兼容性方案回滚并验证恢复结果 |
| Prompt 发布 | 固定 Bundle、运行时、模型参数、工具和数据集；完成配置契约、回归集、保留案例与人工质量审核，验证新旧会话及回滚目标 | 阻止发布；评估通过不自动授予发布权限 |

测试报告区分模拟器、受控模型桩、真实 SDK 请求和真实 Vertex，不互相替代。新 API 的浏览器集成必须实际经过认证与路由，不能通过截获所有业务请求返回 mock 来宣称完整 E2E。线上付费测试设置明确预算和超时，失败保留脱敏证据，不以自动重跑掩盖不稳定问题。

### 10.3 产物、兼容部署与回滚

每个发布产物关联源码 SHA、OpenAPI 哈希、生成客户端版本、后端运行时版本、部署函数清单和适用的 Prompt Bundle 信息；仍按 §10.1 校验逐文件哈希与锁定依赖。部署使用已测试的同一产物，不在部署阶段重新生成另一份契约或重新编译业务代码。

迁移采用兼容扩展顺序：先部署支持新旧客户端的后端及兼容规则，检查后端健康和契约，再发布前端，最后执行线上用户 API 闭环。旧 Callable、旧字段与必要的只读订阅在支持期限内保留；通过实际使用与兼容验收确定下线时机。数据库变更先增加兼容字段，再迁移读写，最后清理，不能把破坏性删除混入可自动回滚的应用发布。

发布快照根据产物中的 Vela 函数清单保存所有受影响函数、Hosting 与 Rules 版本，覆盖新增 API 和调优执行相关组件；仅操作本项目明确管理的资源，不按“六个函数”硬编码，也不按整个云项目无差别回滚。失败时恢复兼容的前端、后端和规则组合并执行恢复冒烟；回滚失败必须显式记录，不能报告发布成功。

代码回滚不自动撤销已写入的业务数据或已发生的模型费用。发布前验证旧版本能够读取迁移后的数据及未完成 turn/评估任务状态；不兼容变更必须先提供单独的数据迁移、恢复与验收方案。取消、重复请求、任务恢复和结算均须按幂等规则处理，避免回滚重启导致重复生成或扣费。

### 10.4 应用发布与 Prompt 发布

应用发布与 Prompt 发布各自具有不可变版本、审核记录、发布记录和回滚目标，共用身份、审计与质量门禁。应用产物声明可接受的 Bundle 契约；Prompt 发布核验目标运行时兼容性及 Remote Config 当前版本，避免并发发布覆盖或形成混合配置。

`/v1/tuning/releases` 及回滚接口只触发受控发布流程，返回可查询的发布记录；不得绕过 PR、CI、人工质量审核或服务端权限检查直接写生产。发布记录区分申请、执行、已发布、已核验、失败及回滚结果，并关联发起 UID、批准记录、源码/Bundle 哈希与流水线运行 ID。上线后核验实际生效版本；既有咨询继续使用冻结 Bundle。

CI 登录专用合成账号取得短期 Firebase ID Token；测试客户端与浏览器分别建立正确认证状态，不把 UID 或 Admin 凭据作为用户身份替代。发布凭据仅用于部署、特殊测试数据准备和清理；任务执行身份、业务用户身份与发布身份分别授权。所有成功及失败路径都尝试清理测试账号与数据，清理失败作为可见故障保留，不泄露 Token、凭据或真实用户档案。


## 11. 统一业务与 Prompt 调优 OpenAPI（2026-11-16，待实施）

### 11.1 目标与适用范围

所有前端业务操作提供正式 HTTP API，以统一 OpenAPI 契约描述；前端、E2E、CLI 与调优 MCP 复用相同业务入口。页面展开、滚动、焦点、Markdown 与海报渲染仍由浏览器验证。Firebase Auth 继续负责登录、凭证刷新和退出，不另建认证系统。

本节为目标设计，不表示接口已实现或已部署。迁移期间 §4 与 §10 描述的现行 Callable、Firestore 直连、本地调优包继续有效。负责人已明确允许突破六个 Cloud Functions 上限；按业务分组部署，一个函数承载多条资源路由。函数数量按实际清单确定，不为每条路由部署一个函数；其他平台、依赖与代码预算不随之自动放开。

### 11.2 认证、授权与数据归属

请求使用 `Authorization: Bearer <Firebase ID Token>`。服务端验证签名、有效期、项目归属后提取 UID；UID 仅是用户标识，不能单独作为凭证，不接受客户端传入 UID 替代认证。Custom Token 必须先经 Firebase 登录换取 ID Token。启用 App Check 强制校验时，测试也配置相应凭据，不通过关闭生产校验实现测试。

普通用户仅访问本人业务数据；调优人员可编辑草稿、执行评估、查看授权范围内结果；发布人员另有发布与回滚权限。建议以受信任管理流程设置的 Custom Claims 表达 `tuningEditor`、`tuningPublisher`，客户端不可自行授予。发布等敏感动作重新核验当前权限与账号状态，不能仅依赖客户端缓存或长期有效的旧权限。审计记录验证后的 UID、动作、目标版本、时间、请求 ID 和结果，不记录 Token。

档案等操作迁到 Admin SDK 后会绕过 Firestore Rules，必须在 API 显式校验输入、资源归属和允许修改的字段；套餐、额度与冻结配置由服务端推导。迁移结束后收紧已废弃的客户端写路径。若暂保留只读实时订阅，必须列为过渡例外，并测试其 Rules；不能宣称已全部收敛。

### 11.3 业务接口与部署分组

以下路由是目标契约，字段沿用现有业务，列表统一使用有界分页。各函数的实际基础 URL 在 OpenAPI `servers` 中声明；普通接口可通过 Hosting 重写提供统一路径。

| 函数组 | 方法与路径 | 职责 |
| --- | --- | --- |
| `accountApi` | `GET/PATCH /v1/me`；`POST /v1/me/exports`；`DELETE /v1/me` | 账户初始化与资料、数据导出、注销；保留订阅取消失败时不误报删号成功的行为 |
| `profilesApi` | `GET/POST /v1/profiles`；`GET/PATCH/DELETE /v1/profiles/{id}` | 出生档案增删改查 |
| `astrologyApi` | `GET /v1/locations`；`POST /v1/charts/natal`；`POST /v1/charts/transits` | 城市搜索、本命盘、指定日期天象；明确参考日期与时区 |
| `sessionsApi` | `GET/POST /v1/sessions`；`GET /v1/sessions/{id}`；`GET /v1/sessions/{id}/messages` | 创建冻结配置的咨询、读取历史与消息 |
| `chatApi` | `POST /v1/sessions/{id}/turns`；`GET /v1/sessions/{id}/turns/{turnId}`；`POST /v1/sessions/{id}/turns/{turnId}/cancel` | 流式生成、结果查询、显式取消 |
| `usageApi` | `GET /v1/me/usage`；`POST /v1/me/share-claims` | 有效额度、分享奖励，保留可信时间与并发事务限制 |
| `billingApi` | `GET /v1/plans`；`GET /v1/me/subscription`；`POST /v1/billing/checkout-sessions`；`POST /v1/billing/portal-sessions` | 复用支付服务与订阅同步能力，用户不能自行写入订阅权益 |

不因接口整理自动增加会话重命名等产品功能。导出数据与浏览器触发下载分离；海报绘制与领取分享奖励分离。

### 11.4 契约、错误与流式对话

复用 `packages/shared` 的 Zod Schema，生成 OpenAPI 3.1 请求与响应结构；路由表定义方法、路径、`operationId`、认证与错误码。前端调用类型与测试客户端使用同一来源。CI 验证生成文档无漂移，并对实际 HTTP 请求、响应与 SSE 事件执行契约检查；仅测试源 Schema 不足以验收。SSE 解析器需单独验证，不能假设通用客户端生成器完整支持流式消费。

错误统一为 `{ "error": { "code": "QUOTA_EXCEEDED", "message": "本月额度已用完", "requestId": "...", "retryable": false } }`，配合合适 HTTP 状态。应用额度不足、模型限流、输入错误、工具 Schema 错误与生成超时分别编码，前端不再依赖错误文本匹配。流开始前可使用 HTTP 错误状态；开始后以明确的失败事件终止，HTTP 200 不能单独算成功。

一次提问与回复建模为 `turn`，具有 `running / completed / failed / cancelled` 状态、关联消息、工具调用和结算状态。客户端提供 `Idempotency-Key`，按用户与操作限定作用域并绑定请求内容：同 Key 同内容返回已有状态或结果；同 Key 不同内容拒绝；并发相同请求不能重复生成或扣费。记录保留期限、过期行为与编辑上一轮语义在实现契约时明确。

SSE 定义 `started / tool / text / chart / completed / failed` 事件，携带请求与 turn 标识。`completed` 表示消息保存与用量结算均成功；模型停止输出不等于业务完成。断线后查询 turn 状态与最终结果，第一版不承诺逐 token 重放。结算与消息提交须具备幂等恢复能力，测试提交成功但结算失败等中间状态，避免重试重复扣费。

显式取消需贯通后端与模型调用；关闭浏览器流不等同于模型停止。取消与完成竞争时以服务端最终状态为准，记录已产生用量，明确部分内容保存及失败/取消结算规则，保留原有历史消息不丢失的保证。

聊天流直达函数入口，配置允许的浏览器来源及必要的 CORS/预检处理。Firebase Hosting 重写有 60 秒请求超时，不能通过增加函数超时消除；客户端、服务端和模型请求的时间预算须一致，不把长聊天放在该代理路径下。

### 11.5 Prompt 调优管理 API

本节调优指 Prompt、模型参数、Reference 与工具配置的编辑、评估和发布，不包括模型权重训练。增加 `tuningApi` 管理接口，共用认证、错误、版本和审计规范，但与普通用户业务权限隔离。

| 方法与路径 | 能力 |
| --- | --- |
| `GET/POST /v1/tuning/prompts` | 查询、新建 Prompt 草稿 |
| `GET/PATCH /v1/tuning/prompts/{id}` | 查看、编辑指定草稿；使用版本条件防止并发覆盖 |
| `GET /v1/tuning/datasets` | 查询授权范围内的合成测试用例集 |
| `POST /v1/tuning/evaluations` | 创建评估任务，固定候选与基线版本、数据集、模型参数及工具模式 |
| `GET /v1/tuning/evaluations/{id}` | 查询状态与分页结果、用量、失败原因 |
| `POST /v1/tuning/evaluations/{id}/cancel` | 请求取消，保留已完成证据与已发生用量 |
| `POST /v1/tuning/comparisons` | 比较两次运行，验证可比条件，输出匿名 A/B 与人工待评项 |
| `GET/POST /v1/tuning/releases` | 查询发布历史或申请发布指定不可变版本 |
| `POST /v1/tuning/releases/{id}/rollback` | 通过受控发布流程恢复指定兼容版本 |

评估与生产复用同一生成函数、Prompt 组装、工具 Schema 转换、模型请求和后处理；评估身份及预算独立，不借用真实用户档案或无限额度。保留 §4.7 的合成案例、固定工具与真实工具两种模式、独立黄金集、人工评审和保留案例要求。

每次运行固定 Prompt/Bundle、工具配置、Reference、数据集、运行时与模型参数版本及哈希，后续草稿修改不影响已启动任务。评估结果记录实际生效参数和最终发送给模型的上下文证据；脱敏后按权限读取，不把真实用户数据或凭据写入报告。

长评估采用异步任务：创建返回 `202` 与任务 ID，状态包括 `queued / running / completed / failed / cancelled / interrupted`。必须由可靠执行器持久化调度，支持租约、取消、超时与重启恢复；HTTP 返回后在进程中继续运行不算可靠后台任务。实施前评估复用现有调优任务执行器的可行性；若需要 Cloud Tasks 等当前禁用平台，另行明确边界变更，函数数量授权不包含该平台授权。任务设置案例数、重复次数、并发、token 与费用上限，不自动重跑已可能计费的请求。

Git 继续是日常编辑与版本来源，Remote Config 继续是生产发布载体。API 草稿须有明确内容哈希与 Git 版本映射，避免形成无同步规则的第二份配置源。发布接口进入现有 PR/审核/CI/发布流程，不绕过质量门槛直接修改生产；只有获授权的发布人员可触发，结果区分已申请、已发布与已核验。回滚恢复完整兼容 Bundle；已有会话保持冻结配置。若发现控制台漂移，按 §4.7 处理后才允许覆盖。

本地脚本与 MCP 可逐步作为 API 客户端，HTTP 调优能力不要求先部署 Remote MCP。保留现有独立本地调优包的可用性，在线模式使用 Firebase 身份；离线模式明确标识本地运行，不冒充线上发布或线上验收。

### 11.6 分阶段迁移与验收

1. **契约与档案闭环**：实现统一认证、错误、OpenAPI 与轻量客户端；迁移账户初始化、档案和必要查询，用用户 Token 完成建档、修改、读取与跨用户越权测试。
2. **聊天闭环**：迁移咨询与聊天，补幂等、状态查询、取消、流式契约及结算恢复；真实 Vertex 验证覆盖普通问题、行运与旧冻结配置。
3. **其余业务收敛**：迁移分享、账户、订阅；前端通过统一业务客户端访问，实时数据改为明确的刷新/订阅策略并验收；支付仅在测试模式验证完整支付流程。
4. **调优统一**：迁移草稿、用例、评估和对比；完成可靠任务执行与权限验收后接入发布/回滚，CLI/MCP 逐步切换为客户端。

旧 Callable 在过渡期间继续调用共享业务实现，避免旧网页失效；确认新版本覆盖、兼容期限和回滚能力后才下线。新增函数必须同步更新 §10 发布快照、部署及回滚清单，不继续硬编码仅六个函数。实际函数数量与所需边界修改随实现提交；首批实施状态与实际边界见 §11.7。

API E2E 用专用合成账号自动登录取得新 Token，业务操作和结果查询均使用用户权限。管理员凭据只用于准备无限额度、额度用尽、旧配置等特殊条件和清理，不代替档案创建、消息读取等用户路径。Token 不进入日志、URL、Git 或测试产物。

验收覆盖建档 → 排盘 → 创建咨询 → 流式生成 → 查询消息 → 查询额度完整链路；同时覆盖本命、行运、合盘、多轮、编辑重试、并发、无限额度、额度用尽、错误恢复、过期/无效 Token、跨用户访问、权限撤销和取消竞争。模型测试断言实际工具调用、有效正文、终态、落库、结算与锁释放，不以 HTTP 200 代替成功。

调优验收包括普通用户拒绝访问、编辑者不能发布、任务重启恢复与取消、版本不可变、A/B 可比性、发布审核及回滚后哈希核验。浏览器保留一条真实完整链路，并检查登录状态、Markdown、移动端、档案切换、刷新恢复、停止重试与实时更新；API 通过不替代 UI 验收。

参考：[Firebase ID Token 验证](https://firebase.google.com/docs/auth/admin/verify-id-tokens)、[OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)、[Firebase Hosting Functions 超时限制](https://firebase.google.com/docs/hosting/functions)。


### 11.7 首批实施记录（2026-11-16，本地候选）

首批增加一个 `businessApi` HTTP 函数承载已实现路由，过渡期保留六个 Callable，总上限依负责人授权调整为七个；未扩大依赖、平台或代码行数预算。实际契约为 `docs/openapi.json`，由业务路由及输入/输出 Schema 生成，只包含已实现的 12 条账户/档案/会话/额度操作与 2 条只读调优操作，不把规划中的评估、发布、聊天 turn 接口列为可用。

HTTP 入口验证 Firebase ID Token、撤销状态及当前用户权限，按部署设置校验 App Check；UID 不能作为凭证。调优接口仅返回 `compiled-default` Bundle 与哈希，不表示 Remote Config 当前发布内容。档案 PATCH 已防止 Zod 部分 Schema 默认值重置未提交字段；消息按创建时间和文档 ID 稳定分页，公开响应过滤冻结 Prompt、锁与内部额度字段。

前端档案创建、修改、删除已改用统一 HTTP 客户端，携带 ID Token 与已配置 App Check Token，身份切换后拒绝继续请求，无隐式重试和 Firestore 写入回退。档案/会话等实时读取和聊天仍保留旧路径，不宣称前端已全量迁移。

CI 增加契约漂移检查、基于 PR 基线的保守兼容检查及真实 Auth/Firestore HTTP 集成测试。兼容检查拒绝既有操作或共享结构变化、允许新增操作，不是完整语义兼容分析。发布产物包含 OpenAPI 文件、哈希及显式函数清单；发布先更新后端，通过用户 API 冒烟后发布并验证 Hosting，再收紧规则并执行完整线上检查（最新顺序见 §11.9）。回滚覆盖清单内旧函数，并清理发布前不存在的本次新增函数；列表处理分页，避免漏掉目标资源。

尚未完成：前端所有读取/其余业务迁移、聊天 turn 幂等/取消与恢复、自动生成客户端类型、在线调优草稿/可靠异步评估/受控发布。现有调优执行器依赖本地文件、内存队列与进程生命周期，不能直接作为云端异步任务使用；需要先落实可靠执行机制及相应平台边界。首批测试证据与部署状态以实际执行结果更新，不将本地通过视为线上已发布。


首批本地验收证据：边界/类型检查、前后端构建、单元/契约及 Prompt 回归通过；Auth/Firestore HTTP 集成与业务事务测试通过；真实 Functions 模拟器验证 Token、禁用账号、调优权限即时撤销；Chromium 加载实际前端档案模块，经真实 Firebase 登录完成 API 创建/修改/查询/删除并核对 Firestore，无请求 mock。既有 UI 回归也通过。Firebase CLI 模拟器强制开放 CORS，因此拒绝外部 Origin 的用例另用同一编译产物的生产 onRequest 包装层、关闭调试覆盖后验证。浏览器 API harness 不等于完整产品页面已全量迁移。新 CI 步骤已写入工作流，本批次尚未经过远端 CI 或生产部署，线上仍为上一发布版本。


### 11.8 分析对象输入与前端业务 API 迁移记录（2026-11-16）

当前优先统一业务 HTTP API，为未来 MCP 适配保留业务函数边界；暂不实施 OpenAI 兼容聊天、产品模型别名或 Remote MCP。既有本地调优管理工具与未来用户排盘工具的权限分离。

分析接口统一接收 `subjects` 数组，每项为 `{ref, profile_id}` 或 `{ref, birth:{datetime, timezone, latitude, longitude, name?, gender?, entityType?, locationName?, consentedOther?}}`，两种输入互斥，可混合引用与直接参数，`ref` 在请求内唯一。服务端按已验证 UID 读取引用档案，校验完整出生参数，解析成统一内部对象；直接参数默认不创建持久档案。档案列表返回 ID 与摘要，UI 无须到处展示 ID。各计算/咨询操作明确允许的对象数量及套餐权限，不承诺任意多人算法。出生时间未知、无法识别时区、不存在或歧义当地时间必须显式处理；没有可靠时间时拒绝依赖精确时间的计算，不能静默补时间。

会话创建时保存解析后的出生对象快照与来源关联，后续档案编辑不改变该会话计算输入；旧会话首次使用时补齐快照，已冻结 Prompt 的规则保持不变。旧 `profileIds` 请求保留兼容，不能与 `subjects` 同时提交。排盘返回结构化数据，对话负责解读，二者复用对象解析及权限规则。

| 前端业务行为 | 迁移目标 | 验收 |
| --- | --- | --- |
| 账户初始化、读取 | `/v1/me` | 用户 Token；条款与成年确认不因轮询而改写 |
| 档案增删改查 | `/v1/profiles` | 实际 HTTP；分页完整；修改后刷新；退出登录取消旧请求 |
| 城市搜索、出生盘预览 | `/v1/locations`、`/v1/charts/natal` | 保留游客录入/预览；游客仅可提交直接出生参数，不能读取已有档案 |
| 指定日期天象 | `/v1/charts/transits` | 明确参考日期/时区与结构化结果，默认日期行为不回退 |
| 咨询列表、创建、消息读取 | `/v1/sessions` 及消息子路径 | 引用/直接输入解析，冻结快照，历史与分页稳定 |
| 流式发送、编辑重试 | `/v1/sessions/{id}/turns` | 真实 HTTP SSE，正文、错误、结束与最终结果可验证；旧 Callable 兼容 |
| 额度与分享奖励 | `/v1/me/usage`、`/v1/me/share-claims` | 服务端有效套餐/无限覆盖、可信时间及原子奖励；无客户端事务回退 |
| 导出、注销 | `/v1/me/exports`、`/v1/me` | 完整数据及删除结果，保留订阅取消失败保护 |
| 商品、订阅、结账、管理入口 | `/v1/plans`、`/v1/me/subscription`、`/v1/billing/*` | 服务端固定套餐价格和跳转范围；未配置支付明确报错；不伪造支付成功 |

业务读取从 Firestore 订阅迁移到可取消的 API 读取与有界刷新：首次立即读、变更后失效刷新、页面恢复可见时刷新；隐藏时暂停定时刷新，避免重复并发和旧用户响应覆盖新用户。数据分页逐页取得，不以第一页冒充全部记录。登录/退出仍由 Firebase Auth SDK，App Check 继续使用 SDK；展开、选择、滚动、Markdown、海报绘制等浏览器交互保持本地。前端不得通过 Firestore 或旧 Callable 静默回退业务操作。

本次验收对照上表逐项验证实际前端调用，并扫描生产代码中残留的 Firestore/Callable 业务访问；测试桩只用于确定性 UI 回归。真实 Auth/Functions/Firestore 与浏览器集成验证新链路。长任务调优、对外 MCP、自动化发布和聊天完整 turn 恢复机制仍按此前独立设计验收，不因协议迁移而宣称完成。


本批实施结果（本地候选）：生产前端业务数据访问已迁移到 HTTP API，移除 Firestore/Callable SDK 业务导入，新增静态回归检查防止重新引入。档案、会话、消息、额度使用分页及可取消轮询；账户初始化、城市/排盘、分享、导出、注销和支付入口使用 HTTP；日期天象使用 `/v1/charts/transits`。登录、退出及 App Check 仍使用 Firebase SDK。旧 Callable 仅服务旧客户端兼容。OpenAPI 当前描述 26 条实际操作，包括 SSE 聊天及只读调优，不包含尚未实现的耐久 turn/调优任务接口。

公开会话提供经投影的 `subjects` 出生快照，前端星盘与聊天使用同一冻结输入，原档案修改或删除不改变已有咨询；内部 Prompt/锁/预留不公开。轮询回调可返回 false 暂缓接收，暂缓结果不标记为已通知，避免生成期间丢失服务端消息同步。访客预览提交直接参数；引用档案必须验证归属。

新 HTTP SSE 与旧 Callable 复用 `createChatRunner`。模型截止 150 秒，HTTP 函数上限 180 秒，锁与额度预留 240 秒；断线传递取消信号，成功以消息与结算完成后的最终 result 为准。错误流不冒充成功，应用额度不足标为不可重试。完整耐久 turn 查询、幂等重放及提交/结算跨事务恢复仍待实现，本次不把传输迁移等同于该设计完成。

支付配置由前端价格变量改为服务端 `STRIPE_PRICE_GO`、`STRIPE_PRICE_PRO`，门户使用 `STRIPE_SECRET_KEY` 与已有 Stripe customer；发布前须配置并在 Stripe 测试模式验收。未配置返回明确错误，本地通过不表示真实支付已验证。星盘响应目前精确描述顶层 envelope，内部动态计算结果使用开放 JSON Schema，算法正确性仍依赖独立黄金集。

本地验收：类型/边界、契约生成检查、前后端构建及单元回归通过；真实 Auth/Firestore 业务集成 9 项、Functions/受控模型聊天集成 3 项通过；真实 Chromium 加载前端模块验证游客排盘、登录初始化、档案 CRUD、咨询创建、消息/额度轮询与分享刷新。聊天模型在模拟器中使用受控生成器，验证实际事务、冻结资料、流式终态、失败清理和租约时长；这不替代发布前真实 Vertex 门禁。部署后脚本已同时覆盖新 HTTP 聊天与旧 Callable 冻结会话。当前尚未提交、远端 CI 或部署；线上版本未改变。


本批最终回归：默认测试 61 通过、1 个模拟器专用用例在默认命令下明确跳过（已在真实模拟器组中运行通过）；业务模拟器 9/9、Functions/聊天 3/3、实际 Chromium API 集成及既有 UI 回归通过。UI 回归的星盘/城市桩已切换新 HTTP 路径，错误展示使用新 SSE/API 错误格式；不再使用无 Token 假用户调用旧 Callable 来冒充新鉴权链路。CI 增加扫描，禁止生产前端重新引入 Firestore/Callable 业务 SDK 访问。Modern Web Guidance 的请求安全要求已应用：生产固定 HTTPS、Token 只经请求头发送且不进入日志，跨域允许来源明确。

### 11.9 业务 API 收尾与持久 turn（2026-11-16，本地候选）

本节更新 §11.7–11.8 的历史实施状态：新增 turn 查询及取消后，OpenAPI 共 28 条实际操作；在线调优写入/可靠任务及 Remote MCP 仍未实现。

- **档案权限**：创建与删除用用户私有锁文档串行化，创建事务同时读取有效套餐覆盖和真实档案数。降档保留已有档案及编辑/删除能力，只阻止超额新增；聊天无限额度不增加档案上限。服务端每次验证 ID Token 后读取当前 `stripeRole`，不等待旧 Token 到期才应用降档。`PROFILE_LIMIT_REACHED` 与模型限流分开，且不可自动重试。
- **套餐与输入**：订阅页面实际读取 `/v1/plans`、`/v1/me/subscription`，显示订阅状态和周期；失败时可重试，不展示旧账号账单。会话创建发送 `subjects`，旧 `profileIds` 仅保留 API 兼容。侧栏、档案管理和工作台也读取 `/v1/plans`；档案数、合盘人数、实体能力、套餐名称及推演深度选项均由返回权益驱动，授权仍以服务端为准。
- **画像**：原画像计算完整移至服务端，本命盘与聊天星盘返回 `portrait`，前端仅渲染。权重、文案、海报与布局不变；画像结构使用明确 Schema，缓存版本升级避免旧缓存缺字段。海报绘制、复制/下载、展开/滚动、Markdown、Firebase Auth/App Check 保持浏览器职责。
- **写入收口**：Rules 关闭档案、账户、额度、会话删除和 Checkout 的客户端直接写入，防止绕过 API 数量及输入验证。已有本人只读规则保留；因此旧会话文档的 `frozenPrompt` 仍可经原有本人读取权限获得，API 投影不被宣称为对这一旧路径的保密措施。私有 Prompt 子文档及 turn 仅服务端可读写。

**Turn 协议**：`POST /v1/sessions/{id}/turns` 可带 `Idempotency-Key`（1–128 位字母、数字、下划线或连字符）；网页在请求前生成 UUID，并仅按 UID/会话持久化标识与请求 SHA-256，不缓存问题正文或 Token。未传 Key 的兼容客户端由服务端生成并通过 `started.turnId` 返回。Key 在用户/会话内绑定规范化请求，包含消息、编辑上一轮与深度；同 Key 不同内容返回 409。同 Key 已完成请求返回保存的 `done/result`，运行中返回 `TURN_RUNNING`，失败/取消后的显式新尝试使用新 Key。记录随账户保留，无自动 TTL 删除及过期 Key 再生成，避免无意重复计费。

`GET /v1/sessions/{id}/turns/{turnId}` 查询 `running/completed/failed/cancelled` 与最终结果；`POST .../{turnId}/cancel` 显式取消。锁与额度预留、turn 租约均为 240 秒；过期 running 在查询或重放时转为 `TURN_INTERRUPTED`，不自动再次调用模型。原执行器终止后残留额度预留按既有到期清理规则处理，锁允许后续新请求在到期后取得；没有新增后台任务平台。第一版不重放逐 token 事件。

**事务与竞争**：保存两条消息、替换上一轮、更新会话、额度结算及 turn 的完成结果在同一 Firestore 事务内提交。取消事务和完成事务读写同一 turn 文档，只有一个终态生效；完成先赢时取消返回 completed，取消先赢时禁止消息/额度提交。预留标识使用会话 ID 与 turn ID 的哈希，防止同一 Key 在不同会话冲突。失败/取消保留原历史、释放预留与锁，不向用户扣本轮额度；已发生的模型供应商成本仍可能存在，取消是向 SDK 尽力传播，不能宣称上游立即停止或不计费。

网页传输失败后查询同一 turn，恢复已完成结果或等待运行状态，绝不因断线自动重新生成；刷新后通过存储标识查询状态并同步持久消息。点击停止会关闭流并另发取消请求，取消请求失败保留标识供后续恢复。跨用户查询/取消必须被拒绝。现有 SSE `text/tool/chart/done/result/error` 保持兼容，增加 `started`；只有带有效最终正文的 result 视为成功，done 不单独表示业务完成。

**发布与验收**：部署顺序调整为 Functions → 用户 API 冒烟 → Hosting → Hosting 版本验证 → 收紧 Rules → 完整冒烟与用户 API 复验。已打开的旧网页在规则收紧后须刷新才能写入；旧 Callable 的 Admin 路径仍保留。失败恢复匹配的函数、规则与前端组合。本地集成检查覆盖并发档案上限、降档、取消/提交竞争、丢失最终响应后恢复、同 Key 重放、跨会话预留隔离、失败事务无部分提交、过期租约及跨用户拒绝。实际测试结果在下方记录；生产 Vertex、Stripe 测试支付与远端发布不因本地测试通过而视作完成。

本轮真实并发回归发现并修复额度预留缺陷：`set(..., {merge:true})` 对非空 `reservations` 映射递归合并，删除的旧 Key 会残留，导致后续请求虚假额度不足。预留、结算和释放现对已存在用量文档使用事务 `update` 整体替换预留映射，仅首次创建使用 `set`，保留 `overrideTier`、`unlimited` 等其他字段。测试明确断言两个并发 turn 完成后预留为空、取消一个不影响另一个，以及覆盖字段保持原值。此前单请求清理成空映射的测试不能发现此问题。

本轮最终本地验收：默认 79 项测试中 77 通过，2 个模拟器专用用例显式跳过并已在真实模拟器组运行通过；Prompt 回归 12/12；真实 Rules/额度事务 2/2、业务 API 11/11、Functions/受控聊天 3/3；真实 Chromium API/订阅组件集成和全套 UI 回归通过。客户端 turn 测试覆盖断线恢复不重复 POST、独立取消、原错误保留、无效最终结果拒绝、身份隔离及多标签页旧请求不能删除新请求恢复标识。类型/代码预算、OpenAPI 漂移、前后端构建与差异检查通过。预算 API 2862/3000、Web 5404/5600、Shared 365/380，未增加依赖或平台。本次修改尚未提交或部署，远端 CI、真实 Vertex 发布验证与 Stripe 支付闭环仍须在对应发布流程完成。

本轮权益收尾：`/v1/plans` 改用明确 Plan Schema，补充 `analysisDepths`，仅当前 Pro 返回三档深度。页面使用可取消轮询同步套餐目录，UID 改变时立即隔离旧结果，套餐变化时按当前 tier 重新选取权益；加载失败清除过期权益，显示错误和重试，不回退静态免费规则。未知权益不按默认上限锁死建档、合盘选择或实体选择，实际提交由服务端拒绝越权。取消了发送消息前基于静态预算的拦截，百分比优先使用用量 API 的 `budgetMicroUsd`，缺失时仅使用 API 套餐预算与已知奖励计算；无限额度单独处理。轮询读取失败后重置通知缓存，保证重试返回与失败前相同数据时也能恢复页面。

权益收尾验收：默认 83 项测试中 81 通过、2 个模拟器专用用例已在实际模拟器组运行通过；业务 API 11/11、Functions/聊天 3/3、浏览器 API 集成及全套 UI 回归通过。新增实际组件 SSR 检查验证非默认的 23 档案/7 人上限、未知权益不误锁、API 预算优先及无限额度；浏览器用实际 `usePlan` 验证首次加载、tier/UID 切换、故障清空及相同响应重试恢复，其中自定义目录和故障阶段使用显式测试响应，原真实 API 链路保留。OpenAPI、类型/边界、前后端构建通过。此轮未增加依赖/平台或放宽预算；仍未提交或部署。

发布凭据修订（2026-11-16）：Gitea Runner 的步骤环境日志会转义多行 JSON，可能绕过整段 Secret 遮罩。部署改为单行 `FIREBASE_SERVICE_ACCOUNT_B64`，仅在权限 0600 的临时文件内解码，退出删除；旧多行 Secret 已移除，对应密钥已撤销。发布验收同时检查原始日志没有包含新凭据或其单行编码，不以 UI 显示遮罩代替验证。

新增 HTTP 函数的首次发布权限：CI 发布身份除既有部署角色外，增加仅包含 `cloudfunctions.functions.setIamPolicy` 的项目自定义角色 `velaHttpsPublisher`，用于新 HTTPS 函数的调用策略设置。发布失败恢复时先查询 Hosting 活动版本；已是快照版本则跳过重复发布，版本未知/查询失败/实际发布失败仍使恢复失败，且继续处理其他资源恢复。新增八项发布测试通过，覆盖同版本重复恢复和真实故障。
