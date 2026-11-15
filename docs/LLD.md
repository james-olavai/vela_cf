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

第一版由 harness 启动本地 stdio MCP，不监听端口，不新增部署函数或 workspace。工程人员一次性配置私有仓库、运行时、凭据和启动入口；占星师通过自然语言选择产品与案例、描述改进目标。远程多人服务与鉴权继续推迟。

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
| 定制化运营后台 UI | Firebase Console + Stripe Dashboard 无法满足非技术运营的日常操作 | 优先接 Rowy / Retool 直连 Firestore；或新增受 `admin: true` Claim 保护的轻量管理页 |
| Google Cloud Model Armor | 线上出现针对 System Prompt 的高频越狱/套词攻击 | 在 `chat` 入口挂载 Google Cloud Model Armor API（前 200 万 Token/月免费，超出 $0.10/M Tokens）做输入/输出双向扫描 |
| 其余排盘技法 | 某个商品需要 | 从 `chart.py` / `astrology_methods.py` 移植到 `packages/astrology`，以对应黄金用例验收 |
| 对外 Remote MCP | 本地 stdio 无法满足明确的远程多人需求 | 另行评审鉴权、部署和函数预算，不能假定现有 6 个函数预算还有空位；本地调优见 §4.7 |
| 第三方社交与开发者平台 SSO（GitHub / Discord / Microsoft / X (Twitter)） | Google + 邮箱登录外，出现明显的开发者/社群/企业单点登录需求 | 在对应第三方开发者后台申请 Client ID & Secret 填入 Firebase Auth，前端在 `AuthGateModal` 增加对应 `OAuthProvider` 按钮 |
| `apps/web` 行数预算上调至 `5600`（原 `5000`）+ `qrcode` | 1:1 完整迁移旧 Vela 能量画像（含日历联动即时天象轮、洞察卡、元素特质、年度能量窗口）与带二维码分享海报 | 负责人批准后同步更新 `boundaries.json` |
| 全量 34 个排盘工具 + `loadSkillReference`（`maxAstrologyTools: 35`） | 先补齐原 `vela` 全部 34 项占星/命理算法，再配合推演深度、智能路由与 Reference 渐进式披露 | `boundaries.json` 同步上调 `packages/astrology`、`packages/shared` 与 `apps/api` 行数与工具上限 |
| 旧工作台前端扩容申请（已撤销） | 目标已改为 §4.7 私有 GitHub + harness + 本地 MCP | 旧 UI 已按负责人要求删除，不扩大原有前端行数预算 |
| 本地 MCP 官方 SDK（2026-11-15 已按用户实施指令接入） | 已安装依赖不能提供 stdio MCP 能力，用户明确要求实施独立调优库 | API 增加固定 `@modelcontextprotocol/sdk@1.32.2` 及依赖白名单，不增加 workspace、部署函数或代码行数预算 |

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
