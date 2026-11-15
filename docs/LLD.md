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
| 自建 Prompt 表 / 静态文件 → **Firebase Remote Config (Server)** | 在 Firebase 控制台直接在线编辑 System Prompt、切换 Gemini 型号、做百分比灰度与一键回滚，无需重发版 |
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
  - 运营/研发可在控制台随时修改 Prompt、切换模型、做百分比随机灰度或一键回滚历史版本，**无需重新部署函数**；代码内仅保留 `defaultConfig` 作为离线/模拟器兜底。
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
  used: number                            -- 本周期已用次数

users/{uid}                               -- 客户端本人可读；年龄确认/初始化受 Rules 约束写入
  email, displayName, acceptedTermsAt, confirmedAdultAt, createdAt

users/{uid}/profiles/{profileId}          -- 客户端本人可增删改查（Rules 校验字段类型与范围）
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

### 4.4 服务端函数清单（上限 6 个）

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
  - 在 Firebase Remote Config (Server) 控制台直接修改对应商品的 `modelName` 或 `systemPrompt` 并发布，新建会话立即生效，零代码改动。
- **LLM 防注入与最小权限护栏（零爆炸半径）**：
  1. **工具零副作用**：暴露给 `ai.defineTool` 的仅限 `packages/astrology` 的 5 个纯数学排盘函数（`natalWheel`、`transitEvents`、`baziPillars`、`ziweiPalaces`、`synastryAspects`），严禁在任何 LLM Tool 中调用 `firebase-admin`、读写数据库、修改配额或访问外部网络（由 `scripts/check-boundaries.mjs` 静态强制检查）。
  2. **输入硬限与步数限制**：单条消息上限 `2000` 字符；`generateStream` 设置 `maxTurns: 3`，防止恶意 Prompt 触发无限工具调用循环。
  3. **指令隔离与防套词**：`frozenPrompt` 必须通过 Genkit `system` 参数下发，禁止与用户输入字符串拼接；每个 Preset 的 System Prompt 末尾统一内置防泄露规则（拒绝复述、翻译或输出系统指令原文）及 Vertex AI `safetySettings`。

---

### 4.7 Prompt 与 Reference Playground（设计待实现）

**实施记录（2026-11-15，首版部分实现，未验收完成）**：运行 `npm run playground`，打开 `http://127.0.0.1:4310/playground.html`。前端监听 `0.0.0.0:4310`，可通过主机局域网 IP 访问；API 仅监听 `127.0.0.1:4311`，由前端同源代理转发，拒绝跨源 API 请求。配置和七个内置案例可无需模型凭据检查；真实生成使用本机 Vertex AI 凭据。占星师界面支持产品/案例选择、文本编辑、版本与草稿保存、双版本顺序比较、诊断查看及导出。草稿当前使用浏览器 localStorage，并非服务端文件保存。生产和本地入口已共用生成函数与按次隔离的工具，完整会话配置存放在受保护私有子文档。

首版尚未覆盖：生产按产品目录选择配置及 Remote Config 发布迁移、共享资源版本发布/影响范围操作、逐片流式预览、富文本编辑与模板变量插入控件、完整结果版本溯源。生产仍按档位/模式读取旧参数；本地 `products.json` 不能视为已与生产商品目录打通。真实模型端到端、测试 Remote Config 发布/回滚和无代码占星师用户测试尚未验证。下文仍是完整目标设计，不因首版存在而视为全部完成。

目标：所有模型可见文本统一登记，可调文本配置化，固定规则只读可见。配置保存在有版本的资源中，Playground 负责编辑、运行与比较。主要用户是没有代码基础的占星师，通过本地浏览器工作台调整产品话术、共享模板、工具说明和技法解读指南；Genkit Developer UI 作为开发人员的辅助诊断入口，用同一生成链路，检查最终上下文、工具调用及回答，并用固定案例比较配置版本。复用现有 Genkit 与 Remote Config；开发入口独立于 Cloud Functions 生产入口。现有 `genkit:ui` 脚本仅是启动基础，尚不代表本节能力已实现。

#### 4.7.1 配置与版本

在 `apps/api` 内集中定义产品配置和共享文本资源，解析后生成可序列化的 `PromptBundle`，由 Zod 校验。每份资源具有稳定 ID、修订名、来源和可编辑标记；共享引用在运行前解析为完整快照，不在运行中追随最新版本。仓库默认值、Remote Config 发布值和本地覆盖值使用同一契约：

| 字段 | 用途与约束 |
| --- | --- |
| `schemaVersion`、`revision` | 配置契约版本与人工可读修订名；运行时另计算完整有效配置的内容哈希 |
| `productId` | 稳定产品标识，用于选择配置；与订阅档位 `tier` 分离，后者控制权限和用量 |
| `systemPrompt` | 顾问角色、解读风格与主要任务 |
| `outputInstructions` | 追问与 `vela-ui` 输出指令；允许调整文案，组件与字段仍受现有输出 Schema 约束 |
| `skills` | 以已有 `SkillKey` 为键的标题、摘要和 Reference 正文；拒绝未知键，未覆盖字段继承指定版本默认值 |
| `toolDescriptions` | 已注册工具的描述，包括 Reference 加载工具；不改变工具名、参数 Schema 或实现 |
| `templates` | 档案、事实、历史呈现和技法选择提示模板；仅支持已声明占位符及有界格式化，不执行任意代码 |
| `modelName`、`temperature` | 模型与采样参数；校验范围，按模型能力处理不支持的参数，并记录实际生效值 |
| `allowedTools` | 使用已有工具名枚举；最终工具为配置、档位权限和当轮路由的交集 |

代码维护不可由配置覆盖的事实约束、免责声明和安全规则，统一追加到组装结果。档位权限、工具 Schema、路由算法与输出校验器仍由代码管理；配置不得赋予额外权限。工具权限、额度和步数上限不可由文案覆盖。工具参数 Schema 内的描述随契约只读展示，修改通过代码版本进行。

所有模型可见的静态角色文本、示例、提示、工具描述和工具返回中的指导性文案均从登记资源读取，业务代码不得散落此类可调字符串。动态档案、用户消息、历史和排盘数据展示来源及实际值；模板保留消息角色与数据边界，禁止把用户数据提升为可信指令。缺失必需占位符或未知占位符应报错。安全规则与事实约束登记为只读资源，始终展示其实际生效版本。

配置解析顺序：仓库默认值 → 对应产品/模式的有效 Remote Config 配置 → 本地运行覆盖值。生产入口只执行前两步；本地默认使用仓库配置或显式导入的配置快照，不自动连接生产 Firebase。Remote Config 失败回退时记录原因、来源及有效配置哈希，不静默隐藏回退；本地非法覆盖直接报错，不回退。

产品目录沿用 `products` 的稳定 slug 作为 `productId`，声明配置键、支持的输入/模式、最低档位及已有能力引用。生产与 Playground 共用目录契约和配置解析器，本地使用目录快照。通过目录查询展示可用产品，flow 接收产品 ID；不编译固定产品枚举。

新增配置使用目录显式声明的 `product_<稳定配置键>` 参数；旧 `preset_${tier}` 和 `preset_${tier}_${mode}` 通过目录的 legacy 映射兼容，缺失字段补齐固定默认值。§4.1 的商品配置与 §4.2 的冻结机制在实现本节时按此契约迁移。新增纯配置产品只需登记目录、配置与案例即可进入 Playground；新增工具、输入 Schema、输出组件或执行流程需实现对应能力后接入共用链路。

新会话冻结 `productId` 和完整有效 Bundle（包含解析后的共享模板、工具描述、Skill 文本、输出指令和模型参数）及其哈希；旧会话缺失字段使用明确的 legacy 默认值，并标记来源。完整快照只保存在服务端受保护的位置，不扩大现有客户端可读会话文档的 Prompt 暴露面；客户端可读文档仅需版本标识。代码护栏升级仍即时生效，运行记录同时注明代码版本，因此“会话冻结”不承诺跨代码版本逐字复现。

#### 4.7.2 共用生成链路与 Reference 注入

从 `chat` 提取一个直接可调用的生成函数，共享路由、上下文组装、排盘、流式生成及后处理。生产入口负责认证、配置读取、配额与会话提交；开发入口负责加载测试输入和本地配置，调用同一个生成函数。

输入包括产品 ID、有效 Bundle、档位、模式、深度、档案、结构化历史消息、用户问题和固定参考时间。当前日期相关逻辑使用该参考时间；生产由服务器提供。输入仍执行生产使用的 Schema 和档位限制。

`loadSkillReference` 保留按需调用方式，从本次运行的有效 Bundle 读取指定技法正文，并返回 `skillKey`、文本及版本标识。通过 Genkit 的运行上下文传递不可变配置，禁止修改全局 `SKILL_CATALOG`；并发实验不得串用配置。工具描述也从本轮快照绑定到生成请求，不能通过修改全局已注册工具实现覆盖；实现时验证 Genkit 版本支持的每次调用工具描述绑定方式，并以并发隔离测试验收。Reference 工具不访问数据库或网络。记录“开放但未调用”与“实际加载”的差别，不能以配置中存在某 Reference 就认定模型使用过它。

第一版提供两种工具模式：`live` 调用真实纯计算排盘工具；`fixture` 使用固定的工具名、规范化参数与结果映射，未命中直接报错，不悄悄转为真实调用。Reference 始终来自本轮配置，避免固定工具结果遮蔽 Reference 修改。fixture 仅隔离工具数据波动，模型生成仍可能有随机性，也仍消耗模型费用。

#### 4.7.3 占星师工作台与可观察结果

页面布局、案例选择、编辑、对比、交付和异常状态的交互规范见 `docs/DESIGN.md` §8；本节定义运行与数据边界。两者均为待实现设计。

新增本地专用入口（建议 `apps/api/src/playground.ts`），注册 `promptPlayground` flow；调整 `genkit:ui` 构建并启动该入口，API 绑定本机回环地址，界面通过同源代理开放 `0.0.0.0:4310`。生产入口不得导入该模块或导出开发 flow。使用现有 Vertex AI 凭据运行模型；不读写生产用户数据、不触发用户配额或订阅流程。

主要用户无需理解 JSON、PromptBundle、工具 Schema 或命令行。首版提供中文本地浏览器界面；工程人员完成安装、模型凭据和启动入口配置，占星师通过桌面快捷入口打开。凭据保留在本地服务端。按负责人要求，当前界面监听 `0.0.0.0:4310` 供可达网络内访问；没有独立用户登录，能够访问该端口的人员均可使用。草稿保存在各访问浏览器中，需导出才能交接；公网多用户认证与权限仍属后续设计。

本地界面复用 `apps/web` 的 React 与回答/卡片组件，以独立开发入口和构建入口组织；本地服务调用共用生成函数，Genkit flow 供开发诊断。用户端生产构建排除工作台及开发服务，不能仅靠隐藏菜单隔离。后端仅监听回环地址，前端代理校验请求来源并使用会话访问令牌，防止其他网页触发本地模型调用或文件操作。复用现有依赖，界面代码计入所属 workspace 预算。

**默认页面与工作流程**：

| 区域 | 占星师看到的内容与操作 |
| --- | --- |
| 顶部 | 产品名称、当前草稿/基线版本、保存状态；“开始解读”“停止”“保存版本”“导出交付包” |
| 左侧：测试案例 | 选择内置星盘、双人组合或咨询案例；普通表单编辑日期、时间、地点和时区；选择问题、历史、参考日期及解读深度 |
| 中间：解读设置 | “顾问角色与风格”“技法解读指南”“技法说明”“回答结构”；使用普通文本编辑，模板变量通过具名插入按钮添加，固定规则只读 |
| 右侧：回答预览 | 按用户产品界面展示正文、星盘卡片和追问；“本次依据”列出使用的星盘事实与解读指南，并区分未加载指南 |
| 对比视图 | 固定同一星盘、问题和参考时间，左右比较“基线版本”和“当前草稿”；显示回答、事实依据、技法选择、耗时与预估成本 |

模型参数、完整上下文、原始回答、JSON、配置哈希和 trace 收进“高级诊断”，普通任务不要求打开。技术名称在界面使用业务名称：Reference 显示为“解读指南”，Tool 显示为“排盘技法”，fixture 显示为“使用固定盘面”。共享资源修改前列出受影响产品，默认保存为当前产品覆盖；更新共享版本需显式选择。

**状态与反馈**：区分未修改、未保存、已保存、运行中、已停止、失败及结果过期。运行绑定启动时的配置快照，运行中继续编辑不会改变本轮结果；编辑后标明旧结果对应的版本。保存草稿持久化到本地限定目录，重新打开可恢复；离开未保存页面提示保存。停止操作尽力取消模型请求并标记不完整结果，已发生的费用仍显示。错误使用可行动中文提示，例如“此案例缺少出生时间”“固定盘面未包含这项技法，请更换案例或使用实时排盘”；不把堆栈当作用户提示。

**交付边界**：占星师保存版本、填写修改说明、勾选案例评价后导出交付包；界面明确显示“本地草稿，尚未上线”。工程人员负责测试环境验证和 Remote Config 生产发布，占星师无需接触 Firebase 控制台。第一版不在工作台提供生产发布按钮。


每次运行返回或关联以下诊断结果：

- 配置来源、修订名、内容哈希、代码版本、模型及实际生效参数。
- 全部模型可见文本的资源清单、来源、版本及可编辑状态；最终 System Prompt、历史与当前消息、工具描述、参数 Schema 和 Skill 目录。
- 共享资源的引用关系；编辑共享模板或 Skill 时列出受影响的产品，支持产品级覆盖或发布共享新版本。
- 各轮工具输入输出、实际加载的 Reference 与版本、未调用的开放工具。
- 模型原始完整文本、提取的卡片与追问、护栏修改/丢弃原因、最终处理后的回答。
- 耗时、模型报告的 token 用量、按已知价格估算的成本；缺失用量或价格明确标为未知。失败保留已完成的 trace 与错误阶段。

流式原始片段与最终处理结果分别记录，不能把最终经过护栏的文本误当成用户在流式期间看到的全部内容。使用合成或脱敏档案；原始 trace 留在本地且不入库，开发入口不启用生产 Firebase telemetry。

#### 4.7.4 案例、比较与发布

内置旧 `code/vela` 的 A（北京）、B（纽约）、C（悉尼）档案、A/B 合盘及 A 迁移伦敦案例，核验授权与合成性质后复制到当前仓库；固定参考时间。旧黄金结果经字段转换及算法约定核验后作为固定盘面使用，运行时不依赖相邻仓库。

在 API 测试资源目录保存少量固定案例，覆盖本命、行运、合盘、缺失出生时间、多轮追问及诱导编造事实。案例包含输入、参考时间和可观察的验收点（事实有依据、工具选择合理、格式可解析、回答相关）。无效档案应在生成前被拒绝；不为测试绕过生产输入校验。

先以基线配置运行，再仅调整指定字段重跑同一案例。保存案例 ID、两份配置快照/哈希及结果到本地忽略目录，人工比较回答质量；事实与格式使用现有校验器。首版不新增模型评分服务或自动 A/B 灰度平台。

调校通过后导出完整有效 Bundle（解析所有共享引用，附带来源清单），经相同 Schema 校验后发布至测试 Remote Config，新建测试会话验证配置哈希、工具加载和结果；确认后再人工发布生产。生产回滚使用上一完整配置，新会话采用回滚值，已有会话保留其冻结配置。模型、护栏或路由代码变更也要重跑固定案例。

#### 4.7.5 实施顺序与验收

按“盘点并登记全部模型可见文本、建立产品目录 → 统一配置并修复温度未生效/安全尾注覆盖 → 提取共用生成链路 → 接入本地服务、占星师界面与辅助 trace → 内置星盘、案例对比和交付包导出”的顺序实施，作为正式 Prompt 调校的前置工作；具体日期待结合现有进度安排。

验收要求：

1. 修改西洋行运 Reference，同一案例实际调用工具时返回新正文与版本，trace 能定位其影响；模型未调用时明确显示未加载。
2. 两个并发运行使用不同 Reference，互不污染；同一输入和配置在生产适配器与开发适配器生成的请求、工具权限及后处理规则一致。
3. 修改温度时实际模型请求正确反映支持的参数；覆盖主 Prompt 不会移除代码护栏；非法配置明确报错。
4. live 与 fixture 两种模式可运行；fixture 未命中失败；可查看原始回答、处理后回答和处理原因。
5. 开发入口无需 Firebase 用户与会话即可运行；生产构建不包含开发 flow；`npm run check`、类型检查及相关配置/并发隔离测试通过。
6. 测试环境发布新 Bundle 后，新会话使用新哈希，旧会话继续使用冻结值；回滚后的新会话使用旧版本。

7. 新增一个复用已有能力的产品，仅增加目录、配置与案例即可在 Playground 查询并运行，无需增加产品分支或重新接入 flow。
8. 修改 Skill 摘要、工具描述或共享模板时，最终模型请求反映改动且能列出受影响产品；两个并发运行的工具描述和模板互不污染。
9. 对照模型请求和每轮工具响应核查全部静态指导文本均已登记；固定规则与参数 Schema 只读可见，未知模板占位符报错。

10. 由无代码基础的占星师完成“打开工作台 → 选择内置星盘 → 修改解读指南 → 运行并查看依据 → 与基线比较 → 保存并导出”全过程，无需编辑 JSON、运行命令或使用 Firebase 控制台。
11. 草稿重启可恢复；运行结果正确绑定版本；失败与停止有明确反馈；生产构建不包含占星师工作台、本地服务或测试档案。

本设计使用既有 workspace、工具注册与本地脚本，不增加部署函数。实现时遵守现有行数及依赖预算；若需要调整预算，按 §6 边界变更约定处理。

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
| 定制化运营后台 UI | Firebase Console + Stripe Dashboard 无法满足非技术运营的日常操作 | 优先接 Rowy / Retool 直连 Firestore；或新增受 `admin: true` Claim 保护的轻量管理页 |
| Google Cloud Model Armor | 线上出现针对 System Prompt 的高频越狱/套词攻击 | 在 `chat` 入口挂载 Google Cloud Model Armor API（前 200 万 Token/月免费，超出 $0.10/M Tokens）做输入/输出双向扫描 |
| 其余排盘技法 | 某个商品需要 | 从 `chart.py` / `astrology_methods.py` 移植到 `packages/astrology`，以对应黄金用例验收 |
| 对外 Remote MCP | 有外部客户端（Claude / Cursor）要接入 | 新增第 6 个 `onRequest` 函数，用 `@genkit-ai/mcp` + 无状态 Streamable HTTP 包装 `packages/astrology` |
| 第三方社交与开发者平台 SSO（GitHub / Discord / Microsoft / X (Twitter)） | Google + 邮箱登录外，出现明显的开发者/社群/企业单点登录需求 | 在对应第三方开发者后台申请 Client ID & Secret 填入 Firebase Auth，前端在 `AuthGateModal` 增加对应 `OAuthProvider` 按钮 |
| `apps/web` 行数预算上调至 `5600`（原 `5000`）+ `qrcode` | 1:1 完整迁移旧 Vela 能量画像（含日历联动即时天象轮、洞察卡、元素特质、年度能量窗口）与带二维码分享海报 | 负责人批准后同步更新 `boundaries.json` |
| 全量 34 个排盘工具 + `loadSkillReference`（`maxAstrologyTools: 35`） | 先补齐原 `vela` 全部 34 项占星/命理算法，再配合推演深度、智能路由与 Reference 渐进式披露 | `boundaries.json` 同步上调 `packages/astrology`、`packages/shared` 与 `apps/api` 行数与工具上限 |
| 本地占星师工作台的前端预算（申请 `5600` → `7000` 行，待负责人批准） | 无代码基础的占星师需要案例表单、文本编辑、版本对比与交付操作；Genkit JSON 面板不足以完成该流程 | 复用现有 React/卡片组件，无新增 workspace、依赖或部署函数；首版前端约 6600 行，获批前不修改 `boundaries.json`，边界检查保持报告超限 |

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

**补充约定**：
- **流式响应失败行为**：模型流式生成中途抛错或中断时，服务端回滚会话锁（`releaseSessionTurn`）与配额预留（`releaseQuota`），不删除上一轮消息、不写入半轮消息；前端捕获异常后将乐观消息列表恢复为调用前快照（`existingMessages`）。
- **分享奖励验证规则**：Web 端第三方社交平台无分享完成回调，产品采用「触发保存海报 / 复制分享文案 / 系统原生分享后解锁领取」的自助激励机制（记录 `lastShareMethod: 'native' | 'poster' | 'copy'`），由服务端可信时间事务与 `firestore.rules`（`request.time`）严格限制每日 1 次、每自然月最多 3 次。
