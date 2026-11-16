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
| Stripe 扩展替代接入（已批准，实施中） | 用户要求线上安装；已发布 0.3.12 固定 Node.js 20 与默认 Firestore，无法满足当前运行时及命名数据库 | 建议在现有 Node.js 22 businessApi 内使用已安装 Stripe SDK，实现 Checkout、Portal 与签名 Webhook；保留现有数据库、区域与函数数量。具体范围见 §11.13，用户已要求派子代理实施；复用原扩展逻辑迁移至二代函数，保留上游许可，不再依赖旧扩展管理服务。部署前仍须通过测试与发布门禁 |
| Token 自助管理前端 5600 → 6000（已批准） | 用户要求现有登录态内申请，避免手工复制 Firebase Token；完整重认证、一次性 secret、权限与撤销界面超出现有约 81 行余量 | 按 §11.11.9 实施；负责人已批准并同步 boundaries.json，不扩大依赖、平台或函数 |
| 隐藏 PAT 与 API 行数预算 3000 → 3600（已批准） | 用户要求实施 §11.11；短期 Firebase ID Token 不替代可撤销、限定权限的用户 API 凭据；当前 API 预算接近用尽 | 保留默认禁用；完整认证、管理及权限检查预计增加 320–440 行，不能压缩安全校验或规避计数。负责人已明确批准，现同步 boundaries.json；依赖、平台、函数数不变；环境发布与常规 Firebase 身份测试先行 |
| 内置地点目录与国家事件盘（2026-11-16 设计确认，待实施） | 用户要求输入地点即时匹配、外部搜索兜底，并从档案自动关联国家盘，避免手填国家成立资料 | 按 §11.10 扩展现有 `businessApi`；不新增函数、平台、依赖或放宽代码预算。仅设计已确认，目录来源审核、接口、前端及验收仍待实施 |
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

个人访问令牌、CI 测试身份及未来 MCP OAuth 的扩展设计见 §11.11；本地实施与部署状态见该节，当前已部署接口仍只接受原有 Firebase 用户鉴权。

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

地点目录、显式外部搜索及国家事件盘目录/推荐的后续 API 设计见 §11.10；这些扩展仍待实施，复用当前 `businessApi` 而非新增部署函数。

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

首次 HTTP 发布还需等待 Cloud Run IAM 传播：2026-11-16 发布记录中，`SetIamPolicy(allUsers/run.invoker)` 成功后一秒请求仍收到网关 HTML 401。`businessApi` 显式声明 `invoker: public`（业务鉴权仍由 Firebase ID Token 与归属检查完成）；Functions 部署后至多 12 次、间隔 10 秒探测不带 Token 的受保护只读路由，只有应用 JSON `401 AUTH_REQUIRED` 才继续真实账户冒烟与 Hosting 发布。永久 IAM 拒绝、错误应用响应或鉴权缺失均阻断发布并恢复旧版本；不会重试业务写入或模型生成。实际编译函数测试检查 invoker 声明，发布测试覆盖传播延迟、永久拒绝和鉴权缺失；非 JSON API 错误仅输出方法、路径、HTTP 状态，不打印响应内容或 Token。

后续线上验收发现同一身份的 POST 201 后 GET 仍出现 Cloud Run HTML 401；一次网关就绪不足以保证 IAM 传播稳定。生产发布对 `businessapi` 采用 [Google 推荐的公开入口模式](https://docs.cloud.google.com/run/docs/authenticating/public)：设置 Cloud Run `invokerIamDisabled=true`，仅关闭平台 Invoker IAM 检查，Firebase Token 校验、撤销/禁用用户检测及归属校验继续由应用执行。发布仅 PATCH `invokerIamDisabled,template.revision`（清空固定 revision 名让平台生成新名，避免 Functions 创建的 revision 重名冲突），等待完成并读回验证，再运行无 Token 拒绝检查和真实身份测试。已有服务的原设置记录到发布快照，失败时恢复；首次创建失败则删除该新增服务。该 PATCH 已用 Google API `validateOnly=true` 验证请求有效，不改变线上旧函数。发布测试 11 项覆盖字段范围、等待/读回、失败阻断、幂等与原配置恢复。

### 11.10 内置地点与国家事件盘 API 设计（2026-11-16，待实施）

本节是用户确认方向后的详细设计，不表示新增接口、目录或 UI 已实现；不改变 §11.7–11.9 已实现接口的当前契约。实现时同步更新共享 Schema、生成 OpenAPI、客户端与测试。所有新路由复用 `businessApi`，继续采用 Firebase ID Token、当前权限与归属校验，不增加 Cloud Functions、数据库平台、运行时依赖或代码预算。未来 MCP 仅适配相同 API，本批不实现 MCP 服务。

#### 11.10.1 数据来源与职责

- **地点目录**：参考旧仓库 `../vela/frontend-v2/public/data/cities/CN.json`（本次核对 2,106 条）及 `../vela/frontend-v2/src/components/cities.ts` 的补充地区、海外常用城市。只复用经整理的公共数据，不迁移旧用户资料，也不照搬旧前端的国家代码硬编码。上线前核实原始数据来源、许可/署名、国家及地区代码、经纬度、IANA 时区、别名和重复项；来源未核实的数据不能作为已审核目录发布。
- **国家事件盘目录**：参考旧仓库 `../vela/vela-agent/backend/alembic/versions/v1a26_country_chart_versions.py` 的来源及版本结构。本次核对该迁移仅有一条已发布中国种子，不代表其他国家已经具备可用资料。旧种子也是待复核输入，不能把旧库的 published 标记直接当成本项目已审核。
- **职责分配**：服务端持有受控目录并负责地点归属校验、国家盘选择、套餐和冻结规则；前端可缓存 API 返回的公共地点目录执行即时文字匹配，不自行维护第二份国家映射或国家盘事件常量。浏览器、直接 API 客户端与未来 MCP 得到相同解析结果。
- **发布方式**：首版采用仓库内版本化 JSON 数据，随已测试后端产物发布，不增加运营后台或在线目录编辑接口。目录及来源说明进入产物哈希检查；更新目录沿用 PR、CI、Gitea → GitHub → 部署流程。每个已发布版本不可修改或复用，历史会话所用资料由快照保留。

#### 11.10.2 地点契约、匹配与缓存

规范地点对象 `LocationRecord` 包含 `id`、`version`、`displayName`、`name`、`aliases[]`、`admin1?`、`countryCode`（国家/地区代码）、`latitude`、`longitude`、`timezone`、`source`（`builtin|external`）。`id` 使用带来源前缀的稳定标识，`version` 标识这条记录的不可变版本；公共目录还返回 `catalogVersion`。这些是地点标识，不是用户身份。

| 方法与路径 | 请求与响应 | 权限及行为 |
| --- | --- | --- |
| `GET /v1/locations/catalog` | `version?`、`cursor?`、`limit?`；返回 `{catalogVersion, items: LocationRecord[], nextCursor}`；默认每页 200、最多 500 | 公共只读。首屏无需全量阻塞；首个分页响应确定版本，后续页固定该版本，不能混合两个发布版本 |
| `GET /v1/locations` | 保留 `query`，新增可选 `source=builtin|external|auto`；保留 `{results}`，结果增补上述可选元数据 | 公共只读。`builtin` 只查内置目录；`external` 显式查询现有外部地理服务或其有效缓存；省略 `source` 为 `auto`，内置无结果再查外部，兼容旧客户端 |

新前端先按需取得目录并缓存，再在本地做中文名称、英文名称、目录内拼音/别名的规范化匹配：去首尾空白、大小写归一，完整名称优先，其次前缀和别名，最多展示 8 项。拼音来自经过审核的目录字段，不新增拼音库、不由模型生成地名。重名结果显示行政区与国家/地区，不按查询字符串静默绑定第一条。自动匹配是展示候选，只有用户选中明确地点才保存坐标。

目录加载期间可通过 `source=builtin` 查询；内置无匹配时显示普通帮助文字「未找到该地点，可点击右侧搜索」，不在每个按键上播报错误。右侧「搜索城市」按钮调用 `source=external`，不在每次输入时发送外部请求。选中后显示地点、时区和坐标供核对；改动文本立即清除旧选择。支持键盘选择、中文输入法、移动端和搜索取消；迟到响应不得覆盖更新后的输入或其他档案。

目录缓存键包含版本，分页未完成时不能把局部目录视作完整的“无匹配”；HTTP ETag/304 仅用于公共目录，相关路由显式覆盖现有全局 `no-store`，并在需要时通过 CORS 暴露 ETag。用户档案和推荐响应继续 `private/no-store`。缺少指定目录版本时返回明确的版本不可用错误，客户端清空该版本的未完成分页并重新加载，不能混入新页。

外部查询保留固定服务地址、有界结果与超时，不接受用户指定上游 URL；不得发送 UID、姓名或出生日期。外部失败与零结果分开：`source=external` 上游不可用返回 503 `LOCATION_PROVIDER_UNAVAILABLE`，不冒充“无此地点”；旧 `auto` 路径继续兼容内置兜底。缺少有效时区或国家/地区代码的结果不得作为可选择的规范地点，不再静默补 `UTC`。

档案及直接出生参数新增可选 `locationRef:{id,version}`；服务端输出 `countryCode` 和来源，作为只读派生字段，不信任客户端提交的国家码。内置引用按目录解析；外部引用由服务端保存已校验的规范结果至现有 `locations_cache` 的按 ID/版本记录（与查询缓存分开），生成引用前须保存成功。缓存引用不可覆盖，失效返回 412 `LOCATION_REFERENCE_UNAVAILABLE` 并要求重新搜索；已保存档案使用其可信地点快照，不依赖临时查询缓存存活。新写入带引用时校验所附地点字段与引用一致，冲突返回 400 `LOCATION_REFERENCE_MISMATCH`；服务端使用规范值，不能把任意客户端坐标标记为目录已验证。

旧档案及直接坐标请求不强制新增字段，仍可排个人/公司盘；没有可验证引用时，地点归属记为 unknown。旧档案重新选择地点后通过正常 PATCH 补齐可信快照；修改任一地点字段但没有相符引用时清除旧的派生归属，不能保留上一次国家。旧地点字符串、语言、浏览器时区、IP 或相邻坐标不足以自动补国家。

#### 11.10.3 国家盘目录与推荐 API

`CountryChartRecord` 包含 `id`、`version`、`countryCode`、`name`、`eventName`、`localDate`、`localTime`（可空）、`timezone`、`placeLabel`、经纬度、`sourceReferences[]`、`sourceNote`、`timeReliability`（`verified|approximate|unknown`）、`isDefault`、`contentHash`。明确这是产品采用的历史事件盘口径，不宣称存在唯一无争议的“国家出生时间”。同一国家可保留多个事件/版本，但每个目录发布版本最多一个可用默认条目；`isDefault` 由目录级 `defaults` 映射派生，不写入不可变事件内容，切换默认无需修改历史事件。默认变更须经目录审核。

草稿仅存在于受审代码资料中，不由公共接口返回。只有来源、时区和事件时间通过审核的记录可发布；`approximate/unknown` 不得自动进入现有精确出生时间算法，不补 00:00 或 12:00，不生成依赖该时间的宫位、轴线等结论。首版只把 `verified` 且通过当地时间有效性校验的记录标为可计算；其他已审核资料可只读展示 `usable:false` 与原因。国家/地区地理代码到国家事件盘的映射由受控目录明确声明，无法唯一映射时返回需选择，不能根据时区或前端硬编码猜测。

国家目录列表同样按 `catalogVersion` 固定分页快照，后续页不得跨版本；指定版本不可用时重新开始列表加载。公开目录可以版本化缓存，个人推荐不得进入共享缓存。

| 方法与路径 | 请求与响应 | 权限及行为 |
| --- | --- | --- |
| `GET /v1/country-charts` | `countryCode?`、`cursor?`、`limit?`；返回 `{catalogVersion,items,nextCursor}`，默认 50、最多 100 | 公共只读；只返回已发布记录及可用性，不产生用户档案或模型费用 |
| `GET /v1/country-charts/{id}?version=…` | 返回指定不可变版本及完整来源；`version` 必填 | 公共只读；不存在的 ID/版本返回 404 `COUNTRY_CHART_NOT_FOUND`，不替换为 latest |
| `GET /v1/profiles/{id}/country-chart` | 返回 `{status,basis,countryCode?,chart?,reason?,catalogVersion,profileUpdatedAt}` | 必须验证 Token 与档案归属；读操作不得创建档案或写回用户国家选择。无权访问的档案统一 404 `PROFILE_NOT_FOUND` |

推荐的 `status` 为 `matched|needs_selection|unavailable`；`basis` 为 `birth_location|registration_location|none`。个人档案依据可信出生地，公司档案依据可信注册地（当前公司档案的地点字段）；出生地不是国籍，也不是现居地。显示「已关联：××国家盘 · 根据出生地/注册地」，允许用户更换目录中的事件盘并查看来源，无需填写国家成立资料。

没有可信地点归属、一个地区没有唯一映射时返回 `needs_selection`；无已发布事件、时间不可靠等返回 `unavailable`，以稳定 `reason` 说明 `LOCATION_COUNTRY_UNKNOWN`、`COUNTRY_MAPPING_AMBIGUOUS`、`COUNTRY_CHART_UNAVAILABLE` 或 `COUNTRY_CHART_TIME_UNVERIFIED`。这些属于正常业务结果，GET 返回 200，不默认中国、不伪造资料。现有手填国家档案不作为推断来源；返回需从目录选择，仍保留其旧分析兼容路径。

本批不新增国籍或现居地资料收集；迁居/现居环境问题需要不同国家时，用户在国家盘目录中明确更换。直接参数 API 客户端可以通过地点元数据及国家盘目录确定显式引用，或使用下一节的会话内自动引用；不能只为取得推荐而强制创建持久档案。公共目录可浏览，计算和咨询仍受当前套餐的实体能力限制。

#### 11.10.4 分析对象引用与会话冻结

沿用 §11.8 的 `subjects`，新增第三种互斥输入；每项只允许 `profile_id`、`birth` 或 `country_chart` 之一，`ref` 仍须在请求内唯一：

```json
{
  "mode": "synastry",
  "subjects": [
    {"ref": "self", "profile_id": "profile_123"},
    {"ref": "country", "country_chart": {"mode": "auto", "source_ref": "self"}}
  ]
}
```

- 自动引用 `country_chart:{mode:'auto',source_ref}` 只引用同一请求中的个人/公司对象，不引用另一个国家盘，不允许环或不存在的 ref。服务端先解析个人/公司及其地点来源，再按目录默认项解析国家盘。档案 ID 必须属于认证用户；直接出生参数须带可验证的地点引用，否则返回需选择，不根据名称/坐标猜国家。
- 显式引用 `country_chart:{id,version}` 用于用户更换国家或事件版本，也可单独作为一个分析对象。两种 country_chart 结构互斥；调用方不能提交或覆写国家事件时间、坐标、来源和可靠性。自动模式使用创建时的已发布默认版本；要求精确复用预览结果时提交显式 ID/版本。
- 扩展现有服务端对象解析器供会话、本命/天象等支持的分析接口复用；每个接口继续执行原有对象数量和实体能力约束，不因新增引用扩展算法数量。公共游客排盘仍只支持原有个人直接参数；国家事件盘计算须登录并满足实体权限。
- 推荐可以自动展示，国家盘不会自动加入所有个人咨询。用户在左侧栏选入关联国家盘，或明确选择其分析对象后，前端发送上述引用；多对象继续使用现有 `synastry` 模式。国家盘不占用户持久档案数量，但每个参与分析的国家盘占一个分析对象名额，执行当前 `/v1/plans` 对应的实体权限及人数上限；服务端不静默加人、删人或提升套餐。
- 会话创建前完成所有引用、权限、时间及对象上限检查；自动关联失败时以 412 和上述稳定业务码返回，不能创建缺少国家盘的半成品会话，也不进行模型预留/结算。客户端可以明确移除该对象后重新创建个人咨询。
- 成功创建时一次保存解析后的 `frozenSubjects`：国家对象含规范事件数据、`countryChartId/version`、`catalogVersion`、`contentHash`、时间可靠性、来源，以及自动推断的 `sourceRef/basis`。后续轮次只读快照；用户改档案、换地点、目录换默认值或撤回条目都不重算旧会话。API 返回经投影的来源摘要和版本，不暴露私有 Prompt、内部锁或其他用户资料。
- 现有国家 `profile_id` 和直接 `birth.entityType=country` 输入继续兼容，明确标记为用户提供，不自动冒充已验证目录资料；不能成为绕过国家实体权限的路径。新的普通 UI 国家盘入口改为目录/自动推荐，不再要求填写国家成立资料。旧手填国家档案可查看和按原流程使用，不自动覆盖或删除。

#### 11.10.5 前端及兼容迁移顺序

1. 整理地点和事件目录、来源、可计算条件及稳定 ID；缺资料的国家保留明确 unavailable，不为扩大覆盖率补造时间。共享 Schema 和路由在现有 API 上兼容扩展，OpenAPI 标明公共/私有操作、分页、错误、互斥输入及可选新增字段。
2. 后端先支持新旧地点/subjects 请求，验证地点引用、推荐、实体权限和冻结行为。旧查询的 `{results}` 与旧档案必填字段保留；若现有保守兼容检查拒绝新增可选字段或 union 分支，应增强兼容判定并增加旧请求/响应契约用例，不直接覆盖基线来掩盖破坏性变化。
3. 新前端启用地点缓存、即时匹配及右侧显式外部搜索；国家盘采用左侧推荐/目录选择与来源展示。档案切换、退出和请求竞争清除私人推荐缓存；先展示加载/不可用状态，不保留其他档案的国家推荐。保存档案和创建咨询仍调用用户 API，不增加 Firestore 直写或旧 Callable 回退。
4. 新会话冻结新增来源；旧会话不自动附加国家盘或改写既有快照。服务端读取已有会话应允许新增来源元数据，前端遇到未知来源类型仍显示已有规范出生对象。发布前必须证明回滚目标能读取新增快照并保持同样权限与计费；若旧版 Schema 会拒绝新元数据，先发布仅增加读兼容的准备版本，再发布产生新数据的版本。
5. 执行 §10 / §11.9 的固定产物发布与回滚。地点/事件目录随产物一起发布，网关仍保持当前 Firebase Token 在应用层验证的配置。任何接口或新数据兼容问题阻断发布；本次设计落盘不启动部署，也不修改生成 OpenAPI 冒充已实现接口。

#### 11.10.6 验收与 CI/CD 增量

| 层次 | 必须覆盖的可观察结果 |
| --- | --- |
| 目录静态验证 | ID/版本唯一、来源和许可信息齐全、坐标及 IANA 时区合法、别名去重、地理映射无隐式默认；同国默认事件唯一；verified 事件时间有效；缺时刻记录不进入精确算法；相同 ID/版本修改内容必须失败 |
| 匹配与前端行为 | 中文/英文/拼音别名、同名行政区、无匹配右侧搜索、无网络时已有目录匹配、分页未完成不报假无结果；改文字清坐标、中文输入法 Enter、键盘/移动端、迟到响应及档案切换隔离 |
| API 契约与鉴权 | 新旧地点请求、两种旧 subjects 及第三种引用均验证实际 HTTP；新公共目录分页/版本/缓存、外部 503 与空结果区别；无效/过期 Token、跨用户档案、伪造国家码/引用/事件资料、套餐越权均拒绝 |
| 推荐与冻结 | 出生地/注册地不同依据、缺地点/缺目录/多映射/时间不可靠、显式覆盖、错误 source_ref/循环引用；自动对象计数不绕上限；编辑/删除原档案、切换目录默认后旧会话版本和计算输入不变 |
| 真实模拟器与浏览器 | Auth + Functions + Firestore 下，真实 Token 完成内置地点建档 → 国家盘推荐 → 创建含国家引用的会话 → 查询冻结结果；不截获全部业务请求。外部地理故障用独立受控桩测试，不以第三方在线可用性决定普通 PR 成败 |
| 发布前后 | 已测试目录/契约哈希进入产物；合成账户通过部署 API 验证地点、推荐、冻结、拒绝路径和清理；增加一条受套餐授权的真实国家盘工具/模型检查，断言使用正确版本和事件资料、有效正文与结算。固定预算与超时，不修改真实用户，不靠自动重试模型掩盖失败 |
| 回滚 | 验证旧客户端可用、目录与后端一致、已保存新快照可读、无重复生成扣费；新接口或真实调用失败即按现有发布流程恢复，记录脱敏证据 |

实现验收时分别记录数据来源核实、模拟器、浏览器、真实上游与远端发布结果，不把设计、测试桩或本地通过写成生产已完成。首批国家覆盖清单及每条事件的时间可靠性，须在实施时逐项核实；本节未承诺旧项目的九个国家代码均有可发布事件。


#### 11.10.7 实施记录（2026-11-16，本地候选，未发布）

三个子代理分别完成地点后端、国家事件盘/冻结及前端交互，主代理整合共享 Schema、入口鉴权、契约兼容、发布门禁与真实集成测试。实现复用一个 `businessApi`，新增四个操作后 OpenAPI 共 32 条；不增加平台、函数、依赖或预算。新目录数据及来源说明进入固定发布产物哈希。

内置地点首版共 2,124 条：旧目录 2,106 个 GeoNames ID 全部与官方 extract 核对并更新地理字段，另补常用海外/地区城市；中文标签沿用旧译名，不宣称人工逐点核实。许可、下载来源及哈希见 `apps/api/data/locations-source.json`，UI 提供 GeoNames 与 CC BY 4.0 链接。前端按版本完整分页缓存，地点每页 500、国家事件每页 100；目录未完整载入时不冒充无匹配。外部查询只在显式点击时触发，缺时区/国家代码结果不选用，失败不以 UTC 或开发兜底掩盖。

国家首版仅发布已核实来源的中国成立事件（`country-cn-founding@1`），其他地点没有可用事件时返回明确原因。事件来源与时间说明见 `apps/api/data/country-charts.sources.md`。国家盘由侧栏推荐、目录选择并明确勾选加入分析，不生成用户国家档案；旧手填档案保持兼容。会话冻结完整事件及来源元数据，模型输入也携带这一快照。当前实体权限在创建、排盘和后续聊天均校验，降档后旧国家会话不能绕过实体权限或对象人数限制。

契约门禁改为受限的增量兼容判断：接受新增可选字段/参数及请求 `anyOf` 分支，继续拒绝删除操作、修改已有约束/认证、增加必填字段及不安全的 `oneOf` 扩展；未重置旧契约基线。公共目录的 ETag/304 与私有推荐的 no-store 均有实际 HTTP 检查。`catalog:check` 纳入 CI，并与 PR 基线比较目录版本、事件不可变内容、默认映射、来源/许可及时间有效性。线上发布冒烟已增加合成 Pro 账户国家盘与真实模型检查，本地测试不代替该真实 Vertex 门禁。

**发布前置条件（已实现强制门禁）**：当前线上 `299c640` 的档案输出 Schema 严格拒绝新增地点元数据，不能作为启用新写入后的安全回滚目标。产物声明 `requiredRollbackCapabilities=['profile-location-metadata']`；发布脚本在部署前只读核实当前线上 `version.json` 的 SHA 与对应能力，缺失立即阻断。新版本成功发布后再核对版本及能力声明；没有环境变量跳过开关。已对当前线上执行只读检查并验证正确拒绝，未执行部署。

后续发布必须先交付读兼容准备版本：档案 GET/list/PATCH/export 与既有国家会话能读取新字段，旧编辑保留未修改的可信地点元数据；使用管理员仅播种合成新结构 fixture，再用真实用户 Token 验证读/编辑/咨询链路。准备版不得启用新引用输入、国家 UI 或其他产生新结构的写路径，`requiredRollbackCapabilities=[]`；只有这些行为通过验收，才声明 `rollbackCapabilities=['profile-location-metadata']` 并正常发布。不能只改版本声明假装兼容。主功能版需等该准备版线上核验完成再发布，生产数据不通过删除新增字段来迁就旧版回滚。


主功能本地验收：默认测试 114 项中 112 通过、2 个真实 Firestore 专用用例在默认命令中显式跳过并在模拟器组运行通过；Prompt 12/12；真实 Rules 2/2、业务 HTTP/Firestore 11/11、Functions/聊天 4/4。真实 Chromium 流程通过地点键盘/IME选择、改字清除选择、保存规范引用、国家推荐/明确选入及会话冻结；既有 API 浏览器回归及完整视觉 UI 回归通过。最后的契约/目录/发布/前端缓存专项 26/26 通过，事件内容哈希额外验证属性顺序不影响版本标识。边界/类型、OpenAPI 生成与旧基线兼容、前后端构建、目录来源/版本检查及本地发布产物哈希验证通过。预算 API 2980/3000、Web 5506/5600、Shared 375/380，未扩大边界。上述为本地证据；没有推送远端、运行生产国家盘模型验收或部署新功能。

读兼容准备版本已在独立工作树 `/tmp/vela-location-read-compat`、分支 `fix/location-read-compat` 完成，本地提交 `9aa5d74bd9ef8c824c898cef597174412e06b0f4`（未推送）：默认 88 项通过、2 项模拟器专用跳过，Prompt 12 项、真实 Functions/聊天 4 项通过，类型/构建/旧基线契约及产物验证通过。主功能已同时通过原线上与准备版 OpenAPI 基线检查；会话响应保留 countryCode/locationSource，档案国家码沿用两位大写约束。契约门禁仅在响应方向允许无约束对象细化为具体对象，带字段名/值约束的对象及请求方向均不放行，已有回归测试覆盖。部署仍须先发布并线上核验准备版，再发布主功能。


### 11.11 个人访问令牌、在线测试与未来 MCP 授权（2026-11-16，部分本地实施）

本节记录用户提出的“先隐藏令牌能力，未来用户自行申请用于 MCP”方向，并承接测试/正式环境发布方案。用户已要求子代理实施；本地实现状态见 §11.11.8，以下目标契约不代表全部已交付。没有创建长期凭据或云端环境，不开放申请入口，按已批准的 3600 行 API 预算实施并更新 OpenAPI，不新增依赖或平台。Remote MCP 仍是后续范围；实现需要另行验收，不因预留认证字段提前建设 OAuth 服务或 MCP 平台。

#### 11.11.1 身份与凭据边界

| 凭据 | 使用方与目的 | 生命周期与边界 |
| --- | --- | --- |
| Firebase ID Token | 网页、现有 API、CI 的常规用户权限 E2E | 保持短期有效，CI 每次运行自动登录获得新 Token；不持久保存个人账户 ID Token 或 refresh token 来维持测试 |
| Vela personal access token（PAT） | 将来的用户脚本、直接 API、支持手动凭据的客户端/本地 MCP 适配器 | 服务端签发、有限期限、限定权限和环境，可逐个撤销；不是 Firebase ID Token 的永久版本 |
| MCP OAuth access token | 未来通用远程 HTTP MCP 客户端 | 经用户授权产生，绑定客户端、scope 和 MCP resource/audience；OAuth 与 PAT 采用不同凭据类型，不能假设所有 MCP 客户端支持手工粘贴 PAT |

UID 始终只是身份标识，不能作为凭证。认证成功后才由服务端形成 `{uid, credentialKind, credentialId?, scopes?, environment}` 上下文；路由继续校验当前账号状态、资源归属、有效套餐和额度，不能信任请求正文、工具参数或自定义 Header 中的 UID/权限。PAT 不携带可长期冻结的管理员或 Pro 权益，降档和账号禁用在后续请求生效。不同凭据汇入现有业务逻辑，不复制档案、生成与结算实现。

#### 11.11.2 隐藏与渐进开放

服务端受控配置采用 `disabled / internal / public` 三种状态，并按环境分别配置。默认 `disabled`：不签发或接受 PAT；网页无创建入口。`internal` 仅允许受控测试 UID 名单签发和使用，生产个人账户不自动进入名单；前端隐藏、查询参数、构建变量或知道接口地址都不能越过服务端开关。`public` 才开放已验收的用户自助申请。状态和名单不能由普通用户写入。

后续关闭能力时，已签发 PAT 也必须停止通过认证；持有效 Firebase 登录的所有者仍能列出和撤销自己的既有令牌。创建入口可隐藏，但已有凭据的撤销能力不能随入口开关丢失。灰度状态下移出名单同样使后续 PAT 请求失效。初期内部测试可通过受控 API 申请，无需先制作公开设置页面。

#### 11.11.3 管理 API 与存储契约

以下为目标接口，复用 `businessApi`，实际实现后才进入生成 OpenAPI：

| 接口 | 请求与响应 | 认证 |
| --- | --- | --- |
| `POST /v1/me/api-tokens` | 输入名称、明确 scopes、期限及可选档案限制；返回令牌元数据及仅此一次的完整 secret，`Cache-Control: no-store` | 仅本人 Firebase ID Token；校验近期认证（建议 5 分钟内）和开放状态，不接受 PAT 创建/续期其他令牌 |
| `GET /v1/me/api-tokens` | 有界分页返回 id、名称、遮罩前缀、权限、期限、状态与近似最近使用时间 | 仅本人 Firebase ID Token；不返回 secret 或摘要 |
| `DELETE /v1/me/api-tokens/{id}` | 幂等撤销；无论是否正在灰度，都保留所有者撤销能力 | 仅本人 Firebase ID Token；不提供 PAT 管理自身之外凭据的旁路 |

建议令牌形如 `vela_pat_<env>_<id>_<secret>`，secret 至少 256 位加密安全随机数；前缀只用于识别，不代表认证成功。Firestore 私有 `apiTokens/{id}` 保存 `uid / environment / audience / name / secretHash / scopes / profileIds / createdAt / expiresAt / revokedAt / lastUsedAt`；只保存强随机 secret 的 SHA-256 摘要，按 id 定位并恒定时间比较摘要。明文只在成功创建时返回，不进入日志、URL、分析埋点、Git、错误详情、导出文件或测试产物；丢失时重新创建并撤销旧凭据，不提供找回。

建议默认 30 天、最长 90 天、每个用户最多 5 个有效 PAT；这些是待实施的默认策略，不是现行产品权益。不签发永久令牌，不自动续期；轮换为创建新令牌、更新客户端、撤销旧令牌，每个令牌独立追踪。管理写入和数量限制使用事务，拒绝未知/重复/空 scope、非法期限、外人或不存在的 profileIds。Firestore 客户端 Rules 拒绝直接读写该集合；账户删除清理其所有 PAT，导出不包含摘要。

PAT 的 audience 由服务端受控资源清单确定，首版仅业务 API；本地 MCP 适配器用该凭据访问业务 API，未来远程 MCP 如支持 PAT，须另行签发面向 MCP 资源的凭据，不能忽略 audience 复用。每次 PAT 请求检查环境、audience、摘要、期限、撤销状态及 Firebase 当前账号存在/禁用状态；账户级撤销需关联统一凭据撤销时间（包括 Firebase `tokensValidAfterTime`），避免只撤销网页登录却遗留 PAT。撤销后的新请求不使用长时间缓存放行；已开始的生成不能承诺瞬时撤回，取消与提交前授权复核复用现有 turn 机制，边界需单独验收。`lastUsedAt` 可合并写入，不作为授权依据。

#### 11.11.4 权限、费用与 API 兼容

建议第一版 scopes 为 `profiles:read`、`charts:compute`、`sessions:read`、`sessions:create`、`turns:write`、`usage:read`。创建令牌时明确勾选，默认最小只读权限；生成能力不默认授予。档案写入/删除、账户导出/删除、支付、分享领额度、Token 管理、Prompt 调优和发布均不在 PAT 首版范围。每条可调用路由声明要求的 scope，未列入允许清单的路由默认拒绝；scope 不能提升用户套餐或访问其他用户数据。

允许限制 `profileIds` 时，它是权限收缩：档案读取、排盘、创建会话、读取已有会话及继续生成均验证涉及的档案；不能通过引用已冻结会话绕过限制。第一版受限令牌不接受直接生辰输入或仅含无 profile_id 对象的会话，国家事件引用也须满足所属请求上下文的限制；若无法完整证明约束，拒绝而非忽略。未来增加更细对象授权须同步契约和测试。

PAT 与网页登录共用用户配额、并发锁、幂等键和用量结算；不得借“API 接入”默认获得无限额度。令牌级限流作为附加限制，免费/付费调用仍受同一用户总额度约束；上线前需确定具体限流值与成本上限。审计仅记录 credentialId、验证后 UID、操作、请求 ID、结果及用量；不得记录认证 Header。

API 使用同一 `Authorization: Bearer` 入口，按显式令牌类型校验；疑似 PAT 格式验证失败不得尝试其他认证分支。现有 Firebase 验证、撤销状态和项目校验不减弱。App Check 按凭据类型和明确路由策略处理：保留网页原有要求，PAT 客户端不假装浏览器；为机器凭据开放的路由仍要求有效 PAT、scope 和服务端限流，不得全局关闭 App Check。OpenAPI 对每个操作如实列出支持的认证类型；管理接口只列 Firebase，不能因顶层声明而自动对所有路由开放 PAT。

#### 11.11.5 MCP 接入预留

未来用户设置提供“开发者接入”入口：命名客户端、选择权限/档案范围、设置期限、一次性复制、查看最近使用和撤销。对支持手工凭据的客户端提供 PAT 配置说明，不能宣传为所有 MCP 客户端通用。

远程 HTTP MCP 单独按当时适用的 MCP 授权规范实现 OAuth 2.1、PKCE、授权与受保护资源发现、scope 授权及 resource/audience 验证；沿用 Firebase 作为用户登录身份源不等于 Firebase 已具备 MCP 所需 OAuth 授权服务。授权服务选型、客户端注册、刷新和撤销机制留待 MCP 实施阶段确定，不在本批自建身份平台。

MCP 接受面向自身资源签发的凭据，验证后通过受信任服务端上下文复用业务能力；若 MCP 与业务 API 分开部署，必须设计验证过的内部委托或令牌交换，不把客户端的 MCP OAuth Token、Google Token 或 Firebase Token 盲目透传到其他 audience 的服务。PAT 不能当作 Firebase Custom Token 使用；也不预留匿名、原始 UID 或任意用户 impersonation 的 MCP 接口。

#### 11.11.6 在线测试与两环境发布衔接

staging / production 采用独立 Firebase 项目及受限部署身份；凭据、Auth 用户、数据库和环境 audience 分开。测试环境不默认复制生产档案。CI 的基础 E2E 继续自动登录合成账户获取 Firebase ID Token，不依赖尚未实现的 PAT，也不要求人工复制个人 Token。PAT 实现后单独增加认证等价性及权限拒绝测试，用仅测试环境、运行结束撤销的令牌验收真实 API；管理员权限只用于 fixtures 准备与清理，不代替业务 API 调用。

发布顺序为固定代码/Prompt/目录产物 → 注入经过校验的 staging 配置 → 部署与真实浏览器/模型矩阵 → 所有必需用例通过 → 同一代码产物绑定 production 配置并校验哈希 → 正式部署后小规模冒烟与失败回滚。环境配置与业务代码分离，保持两个环境的模型版本、关键参数和 API 契约一致；不将测试数据库覆盖生产，也不承诺跨 Hosting/Functions/Rules 原子切换。保留 §11.9 后端先行、前端随后和回滚数据读兼容门禁。

必须覆盖单人、双人、四人、公司、国家盘、额度用尽/无限额度、取消、超时、幂等和结果持久化；保存失败的阶段、脱敏错误码、requestId、耗时及清理结果，不自动重跑模型来覆盖第一次失败。2026-11-16 的验收已暴露双人生成达到 150 秒后误归类为取消/INTERNAL_ERROR，以及国家盘流失败触发回滚；错误分类修复及对应真实验收是后续正式发布的前置条件，不能以新增环境或 Token 能力代替修复。

#### 11.11.7 分阶段验收

1. **环境与常规 CI 身份**：拆分环境配置与固定产物，完成 staging 的自动登录、fixtures 和真实矩阵；正式发布保持原有回滚门禁。
2. **内部 PAT**：实现管理 API、私有存储、principal 与路由 scope 检查；生产默认 disabled，staging 仅 internal 名单。测试跨 UID/环境拒绝、到期/撤销/禁用/降档、管理接口不接受 PAT、不开门时直接请求仍拒绝、无明文泄露、并发创建上限和档案范围不能绕过。
3. **公开接入与 MCP**：明确成本/限流策略、客户端兼容矩阵和 OAuth 服务方案；验收通过后才开放用户申请入口及 MCP，不能只切换 UI 可见性当作完成。新增平台、依赖或代码预算仍遵守仓库边界审批流程。

参考：[Firebase 用户会话与 Token 生命周期](https://firebase.google.com/docs/auth/admin/manage-sessions)、[Firebase 环境隔离建议](https://firebase.google.com/docs/projects/dev-workflows/general-best-practices)、[MCP 2026-07-28 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)。

#### 11.11.8 本地实施与部署前置条件

本批由三个子代理分别负责环境发布、超时与真实测试矩阵、PAT 可行性及独立审查。环境配置和发布脚本已实施：构建一次固定代码产物，分别绑定 staging/production 配置；校验代码清单、哈希以及由可信目标配置产生的五个绑定文件内容。Vertex 证据绑定 SHA、codeHash、环境、项目及 configHash；生产要求同一代码产物的完整 staging 证据，不接受旧结果或被修改的绑定内容。网页从同源 runtime-config.js 载入目标配置，生产构建没有开发配置兜底。

真实模型验收脚本固化 staging 八类与 production 四类用例，检查正文、工具、对象覆盖、终态、持久化、结算、锁释放及档案未修改；失败保留脱敏证据并清理，不自动重试。staging 增加真实 Firebase 登录和部署网页浏览器流程。成本门限基于应用已结算用量，不代表上游账单的硬上限。超时、主动取消、断连和观察失败分别返回安全错误码；生成后提交前重新核实授权与当前套餐。本地 Auth/Firestore HTTP 测试覆盖超时、取消、授权撤销及在途降档。尚未执行新环境的真实模型或浏览器验收。

实际 `config/environments/staging.json` 和 staging 部署凭据尚缺，流水线会明确阻断，不回退到生产。首次部署前须建立独立 Firebase 项目、Web App、Auth、数据库、必要 API 与受限部署身份，按 `staging.example.json` 填入真实配置并运行 `npm run environment:check -- staging`。首次手动运行 workflow 使用 `deploy_firebase=true`、`bootstrap_staging=true`；脚本确认独立 staging 无既有 Functions、Hosting 发布、Auth 用户及 Firestore 集合，读取失败不视为空。生产不允许 bootstrap，后续 staging 发布关闭该开关。

首次 bootstrap 失败时不存在旧版本可恢复：仅清理本次创建的函数、停用 Hosting 并恢复/移除本次 Rules release。停用 Hosting 会留下 disabled release 历史，再次 bootstrap 将被空项目门禁拒绝；应调查残留后规划受控恢复基线，或使用新的独立空 staging 项目，不能删除检查绕过。常规发布失败则恢复已有版本和受管环境变量，保留无关配置。

独立审查发现并修复两处问题：绑定产物不能通过刷新外层 hashes 隐藏代码或配置改动；提交事务在所有异步读取后、每次重试中检查终止信号，避免在途超时仍写入消息和费用，并保留 durable turn 的安全失败分类。事务回归包括最后一次读取时终止、重试期间终止、失败原因与取消区别，以及成功提交后断线不撤销结果。

本地验收：默认 136 项中 134 通过，2 个专用用例在默认组显式跳过并在模拟器通过；真实 Rules 2 项、业务 API 11 项、Functions/聊天 4 项以及 API 浏览器与视觉 UI 回归通过。类型/边界检查、前后端构建、OpenAPI 检查通过；实际构建产物分别使用本地 staging fixture 与 production 配置绑定，验证代码哈希不变及配置内容一致，没有据此部署。

负责人已批准 API 行数预算 3000 → 3600，并同步 boundaries.json。PAT 管理三接口和路由认证已在本地实现，OpenAPI 合计 35 个操作：管理仅接受 Firebase 身份，创建要求 5 分钟内登录；业务入口对明确白名单允许 Firebase 或 PAT，公共目录继续允许匿名。疑似 PAT 不回退到其他验证分支，App Check 的机器例外只适用于验证成功且通过路由授权的 PAT，不改变网页策略。发布绑定仍固定 `PAT_MODE=disabled` 和空名单，默认隐藏网页入口；内部自助管理的后续实现见 §11.11.9。

实际策略为默认 30 天、最长 90 天、每人最多 5 个有效凭据；256 位随机 secret 只在创建响应返回，数据库保存完整令牌的 SHA-256 摘要。用户私有锁通过事务限制并发创建数量；每令牌每分钟 60 次许可请求、其中最多 6 次生成尝试，不替代用户额度和并发锁。权限依据单一 PAT_ROUTE_SCOPES 表生成契约与运行时检查。每次请求及生成提交前重新检查记录、环境/audience、当前 Auth 状态、账户撤销时间、删除状态和当前权限；提交复核不重复消耗令牌请求计数。账户删除在查询订阅及 Stripe 调用前写入 in_progress，再清理所有令牌，防止并发创建漏删。消息/结算事务还读取令牌和账户状态，撤销、删除状态或权限范围修改造成冲突时重试并拒绝；Auth 禁用和全账户撤销属于跨服务状态，由提交前实时复核覆盖，不承诺与 Firestore 原子同步。审计记录服务端身份、credentialId、操作、请求 ID 与结果，不记录令牌明文。

首版受限 profileIds 凭据拒绝档案与会话的集合列表，避免分页过滤遗漏权限；允许读取明确授权的单条资源。请求与冻结会话均检查全部对象，拒绝直接生辰、非授权档案及无法证明来源的国家事件对象；自动国家盘要求 source_ref 指向同一请求中的授权档案。无需范围限制的 PAT 仍支持有界列表。关闭能力后所有者仍可用 Firebase 登录列举及撤销自己的凭据。发布配置目前不自动启用内部 PAT；线上 internal 名单及生命周期验收仍须在独立 staging 配置就绪后受控开展。

PAT 整合后的默认测试 153 项中 150 通过，3 项模拟器专用检查显式跳过并由实际模拟器组运行。真实 PAT HTTP/Auth/Firestore 14 项通过，包含 SDK 事务重试期间撤销、生成期间删除账户、消息与费用不落库、锁与临时身份清理；生成器使用受控结果以确定性触发竞态，不冒充真实模型验收。`test:pat-emulator` 已加入 CI 的 Auth/Firestore 步骤；编译 Functions 回归同时检查默认禁用签发、列表可用与无效 PAT 拒绝。类型/边界、API 构建、OpenAPI 漂移和旧契约兼容检查通过，API 为 3235/3600 行。

无新增依赖、平台或 Cloud Functions。MCP 与公开申请界面仍未实施。本批未提交、推送或部署。

#### 11.11.9 账户内 Token 自助管理与第三方连接边界（本批实施范围）

用户使用现有 Google/Firebase 登录进入「账号与合规设置」中的「开发者接入」。后端由已验证的登录态取得 UID 并自动关联凭据；不要求用户输入 UID、邮箱或 Firebase ID Token，不以客户端提交的邮箱决定归属。Google 登录证明身份，创建 PAT 是用户对脚本/API 的授权；未来第三方远程 MCP 的「连接 Vela → 登录 → 确认权限 → 返回客户端」另走 OAuth 流程，不把个人 PAT 页面宣传为 MCP OAuth。

新增 `GET /v1/me/api-token-capabilities`，仅接受 Firebase，返回 `canCreate / canManage` 布尔值；按当前服务端模式、内部 UID 名单及账户删除状态判定是否可创建，并以至多一条本人令牌记录判断是否保留管理入口。不返回名单或其他用户信息。普通未开放且无令牌的用户不显示入口；允许内部用户显示创建入口；关闭能力或移出名单后，持有既有凭据的用户仍可列表和撤销。接口失败不猜测可创建、不自动重试写操作。所有签发与路由鉴权仍在服务端执行，显示能力不能代替授权。

管理区域复用现有设置弹窗，无新增路由/设置中心。展开后用现有 API 读取本人令牌分页及档案，显示名称、权限、档案范围、有效期、最近使用时间与撤销状态。创建表单提供名称、有效期（7/30/90 天）、明确权限及全部/指定档案；默认仅 `profiles:read`，生成权限不预选。指定档案使用名称选择，说明受限凭据不支持集合列表及直接生辰输入。档案加载失败时不允许悄悄退回全部档案权限；提交期间禁止重复操作。

创建需要近期认证时，由用户点击「验证身份」触发 Firebase 重新认证，Google 账户使用 `reauthenticateWithPopup`，密码账户使用相应 credential；其他登录方式明确提示重新登录。成功后强制刷新 ID Token，确认仍是同一 UID，再由用户明确提交创建。取消弹窗、弹窗被阻止、账户不匹配、切换账户、退出、设置关闭均不得继续签发或展示前一账户结果。不得要求用户复制网页登录凭据。

完整 PAT 仅在成功创建后展示一次，并提供复制和「已保存，关闭」操作；只保存在当前组件内存，不进 localStorage/sessionStorage、URL、日志或统计。关闭设置、切换账户或离开页面即丢弃；复制失败保留可手动选择的只读文本并明确提示失败。创建响应丢失时提示检查列表，无法找回 secret，只能撤销再建；不自动重发 POST。撤销使用当前条目的明确二次确认，完成后刷新列表；失败可显式重试。界面不显示 Token 摘要。

验收覆盖：服务端 capability 与申请开关一致、普通用户隐藏、内部用户创建、关闭后可撤销、过期认证触发重新验证、取消验证不签发、一次性 secret 清理、账户切换/迟到响应隔离、重复点击、复制失败、分页、档案加载失败、撤销及键盘/窄屏交互。真实模拟器覆盖账户与 API 权限；浏览器中 Google 弹窗的取消/成功由受控适配模拟，真实 Google OAuth 仍需在线人工验收，不将模拟结果冒充线上授权通过。

前端当前余量约 81 行，不足容纳完整安全交互，负责人已批准 `apps/web` 5600 → 6000 行；不新增依赖、平台或函数。能力 API、契约和测试已完成，本批接入正式界面，不通过压行或移出 src 绕过边界。默认发布配置保持 PAT disabled，实际 staging 和生产内部名单开启属于后续受控部署。

本节实施验收：capability API、入口路由及生成契约已完成，本地 OpenAPI 共 36 个操作；仅 Firebase 可访问，响应无 UID 名单和令牌内容。负责人批准前端 6000 行预算后，已将 ApiTokensPanel、apiTokens 认证适配与 SettingsModal 接入正式源码，设置关闭或 UID 更换时卸载管理组件。正式页面使用当前登录身份，不需要输入邮箱、UID 或 Firebase Token；默认发布配置仍为 disabled。

默认测试 155 项中 152 通过、3 项专用跳过；既有 PAT 真实 Auth/Firestore/HTTP 16 项及编译 Functions 4 项通过。正式 Settings/Modal 浏览器专项使用正式组件、真实 apiTokens.ts 与 apiClient.ts、最新构建 CSS，仅替换 Firebase SDK 的弹窗及用户状态：覆盖 Google/密码重新认证、getIdToken(true)、取消或认证中切换 UID、不自动 POST、能力与创建响应迟到、折叠/关闭后的密钥清理、Secret 不进入 Storage/URL/console、复制失败、分页、撤销与档案加载失败。首次列表未完成时，按钮和提交处理均阻止创建，避免旧快照覆盖新条目。

实际 Settings 集成发现并修复原删除账号、账号信息及导出区的窄屏 flex 溢出；320px 完整创建表单及指定档案提交、360px 管理视图全部容器无横溢，Tab 焦点约束、Escape 关闭和返回触发控件通过。既有全套视觉 UI 回归通过；停止生成测试改为保持模型 fixture 打开直到点击停止，消除原固定 1 秒完成导致的测试时序竞争，没有放宽业务断言。类型/边界、OpenAPI 漂移、前后端构建和差异检查通过，API 3245/3600、Web 5756/6000。

`npm run test:pat-ui` 已加入 CI，安排在 Web 构建后，使用正式源码和本次构建 CSS；不再支持临时草稿替代。真实 Google OAuth、独立 staging 在线验收仍待部署后执行，不能以受控 SDK 模拟替代。未提交、推送或部署，也未开启生产 PAT 或建立真实账户凭据。


### 11.12 正式域名 velaastro.com

用户已购买 `velaastro.com`，正式网站入口为 `https://velaastro.com`，浏览器 tab 与 Open Graph 页面标题统一为 `VelaAstro`。代码在 shared 中维护正式站点 origin 与对应 Firebase 项目，生产 API CORS 和支付 Checkout/Portal 返回 URL 共用精确 origin 允许列表；保留当前项目的 Firebase 默认 Hosting 域名，staging 不接受生产自定义域名。拒绝 HTTP 降级、任意端口、用户名伪装及相似后缀域名；www 不自动加入允许列表，若启用则先在 Hosting 配置跳转到根域。

正式构建的分享链接和海报二维码使用新主域名；开发及独立 staging 继续使用当前站点 origin，防止测试分享误入生产。API 地址与 PAT audience 仍为当前 Cloud Functions 资源，不因网页换域名改变凭据受众。发布版本检测与回滚仍访问项目的 Firebase 默认 Hosting URL，以便自定义 DNS 未就绪时保留既有发布校验链路。

本批只更新代码，不代表 DNS、HTTPS 或登录授权已生效。上线前在 Firebase Hosting 为当前生产站点连接根域名，按控制台给出的实际记录完成 DNS 验证并等待证书就绪；在 Firebase Authentication 添加 `velaastro.com` 为 Authorized Domain。若启用 reCAPTCHA/App Check，也须为对应 key 配置域名。当前 authDomain 保持已工作的项目 firebaseapp.com；如将来更换登录处理域，还须配置 Google OAuth redirect URI `https://velaastro.com/__/auth/handler` 并同步环境配置和校验，不能只替换字符串。完成后验证 Google 登录/重新认证、邮件登录回跳、支付返回和分享二维码。参见 [Firebase 自定义域名配置](https://firebase.google.com/docs/hosting/custom-domain)。


### 11.13 Stripe 安装预检与付费验收（2026-11-16）

**staging Checkout 实测修复：** 真实候选 API 创建 Checkout 返回 500，Stripe 返回 `property_expansion_max_depth`：订阅列表请求使用 `data.items.data.price.product`，超过 Stripe 最多四层的展开限制。已移除列表请求的多余 expand；商品仍由后续独立 `prices.retrieve(..., {expand:['product']})` 校验。原模拟器直接替换 `subscriptions.list`，未执行 SDK 序列化和供应商参数验证，因此未发现此错误。新增真实 Stripe SDK → 本地 HTTP 供应商契约测试，验证请求携带正确 customer/status，服务端拒绝超过四层展开；该测试覆盖核心 Webhook 的实际查询路径，修复前会失败。签名及 HTTP 契约回归 5/5、API 构建通过；线上修复仍须部署后重新执行实际 Checkout，不以本地通过替代。


**当前状态：尚未安装支付扩展，不能宣称 Vela 线上支付闭环已完成。** 用户提供的根目录 `.env` 中 `stripe_token` 经 Stripe API 验证为测试模式密钥。Go / Pro 商品 metadata `firebaseRole` 正确，默认价格分别为 USD 9.90 / 24.90 每月。当前项目只有 Delete User Data 扩展；Stripe 测试账户尚无 Webhook endpoint。根目录密钥不会自动成为 Functions 的生产配置，不写入源码、前端变量或日志。

安装预检从 Firebase Extensions 注册表及发布源码核实 `invertase/firestore-stripe-payments@0.3.12` 的六个函数均为 Node.js 20、Firestore 触发器和 Admin SDK 固定 `(default)`，没有命名数据库参数。实际业务数据库为新加坡命名数据库，默认数据库位于悉尼。Google [运行时支持表](https://docs.cloud.google.com/functions/docs/runtime-support) 列出 Node.js 20 在 2026-10-30 退役，此后不能创建或重新部署；[Extensions FAQ](https://firebase.google.com/docs/extensions/faq-and-troubleshooting) 公告管理服务于 2027-03-31 关闭，已部署函数不因管理服务关闭而自动停止。此次在预检阶段阻止安装，未发起有部分资源落地风险的部署，未创建支付 secrets 或 Webhook。

**已批准实施方向（用户要求派子代理执行）：** 优先复用原扩展源码与支付行为，迁移为二代函数；参考 Firebase [官方迁移指南](https://firebase.google.com/docs/extensions/users/migrate)及[自建 Function Kit 指南](https://firebase.google.com/docs/extensions/users/migrate-self-created)。官方替代包登记中 Stripe payments 当前为 PENDING_PUBLISHER，不能假定已有 npm 替代包可用。当前项目已将支付行为 API 化，优先将所需逻辑放入现有函数；这属于按现有架构适配原扩展，不宣称六个原函数全部原样迁移。 复用现有 `businessApi`、Node.js 22 和 Stripe SDK，保留新加坡命名数据库与现有付款 API；不增加依赖、函数或其他平台。Checkout 由服务器固定 Go / Pro 价格，客户身份仅取已验证 UID，Customer 创建与 Checkout 创建均持久化幂等键；禁止同一用户重复创建有效订阅。已有订阅通过 Customer Portal 升降级及取消。价格 ID 属于环境配置；API key 和 Webhook secret 存 Secret Manager 并显式绑定函数，不在发布产物中保存明文。

Webhook 是单独的服务器到服务器路径：使用原始请求体验证 Stripe 签名及时间窗，不使用浏览器 Firebase Token 或 PAT；只豁免该精确路径的用户认证。校验环境 mode、已登记 customer→UID、允许的 price/product；不以客户端 metadata 或成功回跳授予权限。处理 Checkout 和订阅/发票相关事件，按事件 ID 幂等，处理重复、乱序和重试；读取 Stripe 当前状态，在用户级同步锁下更新 `customers/{uid}/subscriptions` 及 Auth `stripeRole`，保留其他 Custom Claims。Firestore 与 Auth 非原子，失败返回可重试状态，全部同步成功后才标记事件完成；有效订阅期末取消前保留档位，实际结束后撤回付费档位，拖欠状态按明确策略处理。删除账号保留先取消订阅、后删除 Auth 的现有顺序。具体竞态、同步失败恢复及超时语义须在实施测试中验收，不能用事件时间戳简单覆盖当前状态。

**本次已完成的测试：**

- `apps/api/src/action-api.test.ts` 新增五项支付安全回归；该文件 11/11 通过。覆盖各支付入口未登录拒绝、UID/price/role 注入拒绝、Go/Pro 服务端定价、回跳域名校验且拒绝前不写入、跨用户隔离、pending/completed/failed 状态与错误脱敏、订阅 Timestamp/数值归一化、Portal 缺配置/缺本人 customer 拒绝。默认 `npm test` 和现有 CI 自动执行，不依赖 Stripe 密钥。
- `npm run test:stripe` 新增显式真实 Stripe 测试模式脚本；从环境 `STRIPE_SECRET_KEY` / `stripe_token` 或本地 `.env` 取密钥，拒绝 live key。独立测试客户、不填写真实用户邮箱、不更改真实用户档位；使用 Test Clock、官方测试 PaymentMethod 和实际 Go/Pro 价格，10 项检查通过：商品角色与价格、Checkout session 创建、Go 首次发票 paid、Pro 升级 paid、跨账期新发票 paid、期末取消前 active、期末 canceled。finally 删除测试时钟及关联客户/订阅；本次 cleanup 成功。Checkout 仅验证创建并过期，不冒充浏览器填卡完成。
- 现有删号回归覆盖密钥缺失、取消失败、保留重试状态、仅重试剩余订阅及先取消后删除；它属于模拟测试，不替代真实支付事件回调。

**仍待验收：** Webhook 验签、重复/乱序事件、续费失败、真实 Firebase `stripeRole`/额度同步、Portal 实际操作、真实网页 Checkout、税务与条款配置、线上删号取消订阅、独立 staging 全链路和正式发布。本次 provider 测试只验证 Stripe 自身生命周期，不作为 Vela E2E 或发布通过证据。PR 默认 CI 不注入支付密钥；当前 provider 脚本需显式运行，尚未绑定远端 CI secret。替代接入实施后，受信任 staging 发布必须运行完整支付闭环并保存脱敏证据，失败阻止生产晋级。

**实施与验收更新：** 用户已授权子代理执行。已新增 `stripe-payments.ts`，从原扩展支付处理逻辑改编并在 `third_party/stripe-firebase-extensions/LICENSE` 保留完整上游许可；接入现有 `businessApi`，未新增依赖或 Cloud Function。固定服务端价格，Checkout 开启 automatic_tax、地址更新及条款勾选；Portal 管理已有订阅。精确 `POST /v1/billing/stripe-webhook` 使用原始 Buffer 验签，其他路由保留身份认证。Webhook 读取 Stripe 当前订阅而非采用旧事件 payload，事件成功后才记录完成；共享 `billingLocks/{uid}` 串行化付款、权限同步与删号，进程中断最多等待 15 分钟租约恢复。active/trialing 授予档位，past_due/unpaid/incomplete 撤回付费权限，期末取消前保持 active；保留其他 Auth Claims。删号同时取消 unpaid/incomplete/paused 等仍可恢复的订阅。

默认支付关闭；独立环境配置支持非敏感 `billing.enabled/mode/goPriceId/proPriceId`，staging 拒绝 live；启用时绑定 Secret Manager 中的 `STRIPE_SECRET_KEY` 与 `STRIPE_WEBHOOK_SECRET`。发布回滚恢复原来的 Secret 版本引用以及支付环境变量。该实现是迁移所需支付行为，不包含原扩展的全部商品/价格/单次付款镜像功能。无完整可安装 npm Function Kit 的声明。

本轮默认测试 169 项：166 通过、3 个环境专用测试跳过；新增真实 Auth/Firestore 支付模拟器 10 项通过，覆盖真实 Stripe SDK 签名、锁竞争、实际 Auth Claims、Timestamp 账期、重放/乱序、Auth 失败重试、降档及期末取消，Stripe 查询使用受控 provider fixture，不能代替线上 Stripe Webhook 传送。模拟器命令 `npm run test:stripe-emulator` 已纳入 CI。类型检查、边界检查、API 构建与差异检查通过，API 3394/3600、函数 7/7。

**真实 Stripe 配置阻塞：** 扩展 provider 测试先通过 12 项（含续费失败 past_due）；随后使用核心相同的税务及条款参数测试 Checkout，Stripe 返回 400，明确提示尚未配置公开服务条款 URL。当前 `npm run test:stripe` 保留该失败并强制 finally 清理，不降低参数或跳过断言。故前述旧参数的生命周期通过不能作为实际 Checkout 可用证据。需在 Stripe Dashboard 设置经验证可公开访问的 Terms URL，并验证税务与 Customer Portal 配置，再重跑；尚未修改账户全局条款配置。当前缺实际 staging 环境配置与发布身份，未创建云端支付 secrets、Webhook 或部署；不能以本地测试通过替代 staging/生产闭环。

另提供 `npm run test:stripe-lifecycle`，显式跳过 Checkout、输出 `checkout:not-run` 与 `scope:stripe-provider-only`，最后真实测试 11/11 通过、cleanup 成功；该命令用于独立验证订阅生命周期，不替代默认 Checkout 配置验收或 Vela 支付 E2E。

### 11.14 Firebase 在线配置执行记录

2026-11-16 用户授权通过 CLI 开始配置。已创建并启用 Firebase 独立项目 `velaastro-staging`（项目号 `313389777560`），关联与生产相同结算账户；Firestore `(default)` 位于 `asia-southeast1`，开启删除保护并已成功部署现有安全规则。已注册 Staging Web App、初始化 Auth、启用邮箱密码登录，仅授权 localhost 与 staging 默认 Hosting 域名；Google OAuth 独立 client 尚未配置。公共环境配置保存于 `config/environments/staging.json`，价格使用真实 Stripe test ID，支付 disabled，未复制生产用户数据。

已启用 Functions/Cloud Run/Cloud Build/Artifact Registry/Secret Manager/Vertex AI/Remote Config 等所需 API。在 staging Secret Manager 创建 `STRIPE_SECRET_KEY` 并写入用户提供的测试密钥，未写日志、前端或环境配置；未创建虚假 Webhook secret。创建独立发布身份 `vela-release@velaastro-staging.iam.gserviceaccount.com`，尚未授予完整部署角色或接入 CI 身份，未生成长期私钥。尚未部署 staging Functions、前端或完成在线支付 E2E。

生产 Hosting 已创建 `velaastro.com` 自定义域资源，Auth authorizedDomains 已精确追加根域且保留已有列表。当前状态 OWNERSHIP_MISSING / HOST_UNHOSTED / CERT_VALIDATING，生产前端版本未更换。Firebase 返回根域 A `199.36.158.100`、根域 TXT `hosting-site=yhvhchen-387212`，另有当前证书 `_acme-challenge` TXT；证书挑战值须以实际 API 查询结果为准。待用户提供 DNS 服务商信息或自行添加记录后继续验证。Stripe Tax 缺少真实 head_office，已向用户请求经营地址或自行填写；条款 URL 需公开可访问后配置。

**用户配置后的复测：** Stripe Tax 已变为 active；使用税务及 required 条款参数的 `npm run test:stripe` 12/12 通过，含 Checkout 创建、付款、升级、续订、期末取消、失败续费及拖欠取消，cleanup:true。测试脚本已改为固定读取 staging 配置生成回跳 origin，随后单独用该 staging origin 创建同参数 Checkout 并验证成功/取消地址、tax enabled、terms required，成功且已清理。仅创建并过期 Checkout，不代表浏览器付款或真实 Webhook 同步完成。

在线探测 staging `/terms`、`/privacy` 和 `/businessApi/v1/plans` 仍为 404，应用未部署；现有默认 Portal 配置支持取消，但 subscription_update disabled、默认返回与门户条款 URL 尚未设置。不能以 Stripe provider 通过宣布完整支付上线。


**首次 staging 本地引导例外：** 为实际创建的新 staging 项目提供显式 `VELA_BOOTSTRAP_STAGING=true` 本地执行路径，仅允许 `environment=staging` 且使用明确指定、同项目的 impersonated service account / 带 SA impersonation 的 WIF ADC；记录 `releaseOrigin: local-staging-bootstrap`，不设置虚假的 `CI=true`。生产及非 bootstrap 本地发布继续拒绝。该入口只放宽执行地点，保留干净源码与固定产物校验、环境绑定、真实 Vertex 候选证据、空项目检查、失败回滚、浏览器与真实模型矩阵等全部检查；空项目检查失败即拒绝，不能用于二次发布。CI 正常发布记录 `releaseOrigin: ci`，生产晋级仍要求独立 staging 证据。


首次 staging 引导失败后，回滚会删除本次创建的函数并禁用 Hosting；Hosting 保留 `SITE_DISABLE` 历史记录。重试空项目检查允许完整历史中仅存在无 `version` 的 `SITE_DISABLE`，按 `pageSize=100` 查询且存在分页即拒绝；任何真实部署、未知 release 类型、附带版本、已有函数/用户/Firestore 集合或查询失败仍拒绝。该例外仅允许失败引导后的空站点重试，不适用于已有应用发布。


Firebase CLI 会优先使用本机缓存登录，因此仅设置 ADC 不足以证明发布身份。部署及 bootstrap 回滚禁用 Hosting 均通过隔离执行器运行：每次创建独立临时 `XDG_CONFIG_HOME`、移除 `FIREBASE_TOKEN`、将 ADC 转成绝对路径；保留原 `CLOUDSDK_CONFIG` 供短期 impersonation 读取源身份，执行后清理临时目录。此前实际回滚的 releaseUser 为本机邮箱，不能称为已通过专用 SA 部署；后续须结合实际审计记录确认。


**受控本地 staging 更新：** 用户持续授权完成在线验证后，新增显式 `VELA_LOCAL_STAGING_RELEASE=true`，允许在已有独立 staging 上使用同项目且明确指定的 impersonated SA / SA impersonation WIF 进行正常更新，记录 `releaseOrigin: local-staging-release`。生产的所有本地发布仍拒绝；未显式设置 flag 的普通本地更新仍拒绝。bootstrap 仍须独立 `VELA_BOOTSTRAP_STAGING=true` 并通过空目标检查；正常更新继续验证既有版本的回滚能力、保存函数/Hosting/Rules/secret 引用快照，固定产物与环境绑定、真实 Vertex 候选证据、浏览器和八场景真实模型矩阵全部保留，失败按既有流程回滚。不设置虚假的 CI 状态。

### 11.15 Staging 发布及真实支付验收完成

已通过独立发布 SA 的短期 impersonation 部署 staging，线上版本 `62462c6bb79548a7cfa4c48ad9c62cd90c9487d6`，站点 `https://velaastro-staging.web.app`。首次发布因 Artifact Registry 未设置清理策略触发回滚，现已配置新加坡 gcf-artifacts 镜像 7 天清理；空站点 SITE_DISABLE 重试和 Firebase CLI 独立凭据目录均已补回归。最终发布 `status:verified`、`billingVerified:true`，候选 Vertex、实际网页浏览器、8 个真实模型场景与 API 复验全部通过。场景覆盖免费、单人、双人、四人、公司、国家、冻结旧配置无限额度和耗尽额度。最终候选本地 179 项中 176 通过、3 项显式跳过，类型/边界/OpenAPI/构建通过。

真实 Stripe 发布门禁完成 7 项检查：API 创建 Checkout、客户 UID 映射、Go 已付订阅经真实 Webhook 同步至 Auth 及额度、Portal API、Pro 升级及取消恢复免费，cleanup:true。发布门禁只在 staging 且 billing.enabled 时执行，失败触发回滚；证据绑定实际 SHA/codeHash/configHash/projectId，不读旧成功报告。

另以实际 Chromium 提交 Stripe 测试卡、测试账单信息与 required 条款，Stripe 确认 Checkout complete 和首张发票 paid；随后真实 Webhook Go → Pro → canceled/free、Portal API 均通过，共 7 项检查，cleanup:true。浏览器脚本修正 Stripe iframe 新控件（邮箱为 type=text、autocomplete=email）、提交前必填字段校验和键盘勾选条款，依真实截图/DOM 定位问题，不绕过验证。升级及取消通过 Stripe SDK 驱动并验证真实回调；未将其冒充 Portal 内点击操作测试。条款与隐私页已用真实浏览器验证标题和正文路由可渲染。

本轮部署在隔离工作树中使用已提交、保留自动计税的版本；主工作区出现的关闭自动计税及条款文案编辑未纳入该部署。生产账单配置仍未在本轮启用或发布，Google OAuth 独立 staging client 尚待配置。脱敏证据保存在本地 `artifacts/staging-62462c6/`：release-result、stripe-release-evidence、stripe-browser-live、staging-browser、live-smoke、vertex-live；不得提交凭据和支付会话 URL。

### 11.16 公司合盘补充验收

在已部署的 staging 上新增独立补充测试，不改原有 8 场景及生产晋级契约。`npm run test:company-synastry-live` 要求显式 `VELA_ENVIRONMENT=staging`，包含个人＋公司与公司＋公司两个组合，最多 2 次场景、8 分钟、应用结算预算 USD 0.30；Pro 覆盖在公司档案创建前设置。两项真实 Firebase/API/Vertex 测试均通过，真实调用 synastryAspects，校验冻结对象类型及称呼、双名字、turn 完成、消息落库、额度结算和锁释放、档案未被分析修改，cleanup passed；本轮结算 USD 0.121701。用例及生产误调用拒绝等本地契约 6/6 通过。

`npm run test:company-synastry-browser` 使用真实已部署页面、Firebase SDK 登录、左侧主档案与合盘多选、输入框提交、真实 API/Vertex SSE，业务请求不 mock。个人＋公司及公司＋公司两项均通过，准确执行 2 次生成，验证请求对象与冻结类型、双方完整名称、实际 synastryAspects 和消息持久化；公司＋公司另实际调用双方 companyTenthHouse。无浏览器异常，结算 USD 0.090486，cleanup:true，独立 Auth 用户及其档案/会话/用量已删除。

报告分别为 `artifacts/company-synastry-live.json`、`artifacts/company-synastry-browser.json`。补充的是测试脚本，本次没有修改或部署应用业务代码；原工作区的税务与正式价格配置编辑未纳入该测试提交。前端用例首次等待水合超时发生在生成前，已根据真实页面修正等待条件并保留真实请求和断言，不使用 mock 或自动重试掩盖模型失败。

### 11.17 Gitea Actions 分阶段发布

按用户要求，工作流分为 `ci（本地测试）→ deploy-staging → verify-staging → deploy-production` 四个独立 job。PR 只运行本地测试；main push、v* tag push 及明确勾选发布的 main 手动任务走完整流水线。前一阶段失败或跳过，后续生产发布不会执行。当前实例为 Gitea 1.25.5，其 [1.25 官方兼容说明](https://docs.gitea.com/1.25/usage/actions/comparison/) 指出 concurrency 与 job timeout-minutes 被忽略，因此不用这些 YAML 字段作为串行或超时保证；实际命令使用 GNU timeout，环境发布使用 Firestore compare-and-set 锁。

1. **本地测试与构建**：类型/边界、OpenAPI 兼容、单元测试、模拟器、UI/API 浏览器回归；仅在这里构建一次，打包干净 Git 提交对应的不可变产物。
2. **部署测试环境**：下载原始产物并绑定 staging 配置，验证真实候选 Vertex，取得环境锁后保存旧 Functions/Secrets 引用/Hosting/Rules 快照，再部署并执行必要就绪检查。成功仅生成 `status:deployed` 的 deployment receipt，不生成 verified 发布结果。receipt 绑定 SHA、codeHash、configHash、项目、流水线 owner 与 rollback 快照哈希，随脱敏部署证据上传。
3. **在线验收**：重新下载同一原始产物与本次部署证据；不重新构建或部署。验证 receipt、快照哈希、流水线锁和当前 Hosting 版本后，运行真实 Stripe Webhook 权限与额度同步、真实网页流程、原有 8 个模型场景，以及个人＋公司/公司＋公司的 API 与真实 UI 合盘补充测试。全部通过且 fixture 清理成功才产生 verified 证据。过程中的测试失败按原快照回滚；锁丢失或站点已被手工替换时拒绝覆盖更新版本。
4. **生产发布并验证**：只依赖在线验收成功；从同一原始产物绑定生产配置，不重新构建。晋级检查要求同 SHA/codeHash/staging configHash、8 场景、两类公司 API/UI 验收及启用支付时的匹配支付证据；随后运行生产候选检查、部署、线上冒烟，失败恢复生产快照。

`VELA_RELEASE_PHASE=deploy|verify|all` 将分段行为落实到脚本，生产仅允许 all。CI 使用独立私有临时凭据目录与两套项目凭据，下载/上传的证据不包含原始 secret 或支付 URL；wrapper 在退出及信号处理时删除临时配置。既有服务账号 JSON secret 可继续使用，配置 impersonation/WIF ADC 时须同时设置对应项目的 release service account 变量。Gitea 1.25 不提供 GitHub 等价的 environment 审批或 OIDC id-token 能力，不能仅加 YAML 字段便声称具有这些保护。

`releaseLocks/pipeline` 位于各环境自己的 Firestore，2 小时租约从 staging 部署持续到在线验收完成；生产使用自己的锁。获取、过期接管和释放均带 Firestore 写入前置条件，过期或不同 owner 无权继续验证/回滚。首次空环境检查只豁免发布锁集合，仍拒绝业务数据。另一个发布占锁时新任务直接失败，不并发覆盖。若 runner 被强杀、任务取消或证据传输失败，使在线验证进程未能运行，生产仍被阻止；应使用留存快照人工恢复和检查锁，不能把租约到期视作自动完成回滚。

本次本地完整测试 185 项：182 通过、3 项环境专用跳过；发布/环境/阶段组 37/37，通过 YAML 实际解析与四阶段依赖图检查、真实 staging Firestore 锁竞争与清理验证。部署与验收分段的顺序、失败阻断回归均通过。未触发远端 Gitea Actions、未发布生产；线上仍运行前一轮已验证 staging 版本。首轮远端执行需要已配置的 `FIREBASE_STAGING_SERVICE_ACCOUNT_B64`、`FIREBASE_SERVICE_ACCOUNT_B64`，若用 ADC 模拟则还需对应 `FIREBASE_STAGING_RELEASE_SERVICE_ACCOUNT` / `FIREBASE_RELEASE_SERVICE_ACCOUNT` 变量。

保护分支 required status context 为 `Vela CI/CD / ci (pull_request)`；本地测试 job 保留 `ci` 名称以兼容该规则，不降低或跳过保护分支检查。
