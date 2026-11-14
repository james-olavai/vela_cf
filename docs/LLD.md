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
   ├─ 登录与鉴权 ──────► Firebase Auth（仅 Google OAuth，携带 stripeRole Custom Claim）
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

## 5. `apps/web`（前端）

前端为托管在 Firebase Hosting 上的 React + Vite 单页应用，复用 `../vela/frontend-v2` 的视觉与组件，数据层完全基于 Firebase Web SDK（模块化 v10+）重写：

| 部分 | 处理 |
| --- | --- |
| UI 组件、样式、`@assistant-ui/react` 界面（非 admin 部分约 4200 行 TSX） | 保留；移除旧的 `R1*` 强耦合 props |
| 登录与会话 | `firebase/auth`（`signInWithPopup` + `GoogleAuthProvider`），监听 `onIdTokenChanged` 获取 `stripeRole` |
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
| 邮箱登录 | 有相当比例用户没有 Google 账号 | 在 Firebase Auth 启用 Email Enumeration Protection 与邮箱链接/验证码登录 |

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
