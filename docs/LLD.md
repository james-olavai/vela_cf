# Vela CF — 低层设计文档（LLD）

> 目标：在 `/home/yhvh/code/vela_cf` 新建全栈 TypeScript + Cloudflare 原生项目，甩掉老仓库的 Python/Node 子进程双运行时、自建 Casdoor、Nginx/Redis 以及双池 credit 账本，复用 `vela` 的排盘口径、黄金测试集、产品 Preset 与前端 UI 组件。
>
> **目标用户：海外用户。** Cloudflare 全球边缘 + Stripe 订阅 + Google 登录是合适的基础，不考虑大陆可达性、备案与微信/支付宝。
>
> **全新上线，不迁移旧系统的用户、档案与余额。**
>
> **第一阶段原则：一个 Worker、一个模型、一个数据库。** 其余组件等出现具体需求再加，见 §6。

---

## 1. 总体架构

```text
[用户]
   │
   └──► Cloudflare Worker (apps/api：Hono，同源托管前端)
            ├─ 静态资源：apps/web 的构建产物（Workers Static Assets），/api/* 之外回落到 SPA
            ├─ 认证 & 订阅：Better Auth + @better-auth/stripe（表由它生成）
            ├─ 数据层：Drizzle ORM → D1（唯一存储）
            ├─ 排盘：直接 import packages/astrology（纯函数，注册为 AI SDK tool）
            ├─ 对话：Vercel AI SDK streamText + Tool Calling
            ├─ 模型：两个适配器，经 CF AI Gateway 转发；具体供应商待定（§7）
            │    ├─ @ai-sdk/openai-compatible：任何 OpenAI 兼容接口
            │    └─ @ai-sdk/google：Gemini API
            └─ 可观测：AI Gateway 自带的请求 / token / 成本日志

apps/
   ├─ api/         # 唯一的 Worker
   └─ web/         # React + Vite 前端，构建产物由 apps/api 托管
packages/
   ├─ astrology/   # 中西排盘纯函数 + 回归测试
   └─ shared/      # 订阅档位 (free/go/pro)、配额上限、API 类型
```

前端与 API 同源：登录 Cookie 不跨域，不需要 CORS，只有一处部署。

与最初脚手架相比去掉的东西：

| 去掉 | 原因 |
| --- | --- |
| 主 API 经 Service Binding 走 MCP 协议调排盘、`McpAgent` + Durable Object | 排盘是纯函数，同进程 import 即可；MCP 只对外部客户端有意义，推迟到 §6 |
| Cloudflare Pages 单独托管前端 | 同一个 Worker 托管静态资源即可，省掉跨域 Cookie 与 CORS |
| Admin 界面、Cloudflare Access | 只有 3 个 Preset，改商品直接用 SQL / Drizzle Studio，推迟到 §6 |
| Workers AI 专用绑定与 `workers-ai-provider` | 需要时走它的 OpenAI 兼容接口即可，不必单独接一套 |
| 按档位做模型路由 | 与 `products.model_name` 冲突，只保留后者；Free 每月 3 次，不值得为它单独配一个便宜模型 |
| Cron 月度重置配额 | 覆盖不了跟随 Stripe 账期的付费档，改为惰性重置（§4.3） |
| KV | 仅用于城市缓存，D1 一张表足够 |
| Langfuse、PostHog | AI Gateway 日志先够用 |
| 手写 SQL 迁移 | 与 Drizzle schema 是两个事实来源，改为 drizzle-kit 生成 |

---

## 2. 可复用的原项目资产（`../vela/`）

| 原项目路径 | 复用方式 | 说明 |
| --- | --- | --- |
| `vela-agent/backend/app/astrology_capabilities.py` | 契约与 Schema 基准 | `natal`、`transit_timeline`、`bazi`、`ziwei` 的输入/输出结构与版本策略。 |
| `vela-agent/backend/app/ephemeris.py`（151 行） | 西占计算口径 | `swe.calc` + `FLG_SWIEPH \| FLG_SPEED`、Placidus 宫位（`swe.houses`）、儒略日按 `hour + minute/60` 截断秒。 |
| `vela-agent/backend/app/chart.py`（2071 行） | 只移植 4 个工具用到的部分 | 其余 20 多种技法不在第一阶段，见 §3.2。 |
| `vela-agent/backend/app/astrology_eastern_sdk.py`（323 行） | 东占计算口径 | `vela-eastern-lat-v1` 真太阳时、立春/节气分界、`iztro` 参数口径。 |
| `vela-agent/backend/app/ephe/seas_18.se1`（223 KB） | 随 Worker 打包 | 凯龙星等小行星用。 |
| `vela-agent/backend/tests/golden/charts_golden.json` | 西占回归基准 | 只用其中与 4 个工具对应的用例，见 §3.2。 |
| `vela-agent/backend/product-presets/standard-v1` | 初始化数据 | Prompt 与工具权限，导入 D1 `products` 表。 |
| `frontend-v2/` | **只复用 UI 组件与样式** | 数据层需要重写，见 §5。 |

---

## 3. `packages/astrology`（排盘纯函数）

### 3.1 范围

四个导出函数，入参/出参用 zod 定义，同一份 schema 既给 AI SDK tool 用，也给将来的 MCP 壳用：

- `natalWheel({ birthDateTime, latitude, longitude, timezone })`
- `transitEvents({ ...natal, windowMonths: 3 | 6 | 12 })`
- `baziPillars({ ..., yearBoundary: "lichun" | "civil_year" })`
- `ziweiPalaces({ ..., gender: "male" | "female" })`

东占用 `lunar-javascript` + `iztro@2.6.1`（与旧仓库同版本）。西占用 **Swiss Ephemeris WASM（已定）**，与旧代码是同一套算法。

**不在第一阶段**：黄金集覆盖的其余技法（合盘、组合盘、次限、太阳弧、太阳/月亮返照、法达、恒星、小限、黄道释放等，对应 `chart.py` 的大部分与 `astrology_methods.py`）。某个商品需要时再移植，届时对应的黄金用例即为验收标准。

### 3.2 验收

一个测试脚本，超出容差即失败：

- **西占**：`charts_golden.json` 中的 `natal_A`、`natal_B`、`natal_C`、`transit_timeline_A_2026H1`。`transit_London` 是单时刻行运盘，Phase 0 确认它是否在 `transitEvents` 的契约内，是则纳入。
- **东占**：黄金集里没有八字和紫微用例。Phase 0 用旧 Python 代码对 A/B/C 三个档案导出八字与紫微结果，存为 `packages/astrology/test/eastern_golden.json`，作为东占基准。

### 3.3 Phase 0 必须先验证的三件事

1. **星历模式**：旧仓库 `app/ephe/` 下只有小行星文件 `seas_*.se1` 和恒星表，没有行星与月亮的星历文件。推断旧结果的行星位置实际走的是 Swiss Ephemeris 内置的 Moshier 回退。验证方法：WASM 版用 Moshier 模式 + `seas_18.se1` 计算 `natal_A`，与黄金集比对。成立的话 Worker 只需额外打包 223 KB，体积不构成风险。
2. **封装层许可**：商业授权只覆盖 Astrodienst 的 Swiss Ephemeris 代码，不覆盖第三方封装。原候选 `@fusionstrings/swiss-eph`（0.1.1）在 npm 上标注为 AGPL-3.0，不能直接用于闭源服务。需另选宽松许可的封装，或用 Emscripten 从官方 C 源码自行编译。
3. **Workers 运行**：WASM 在 Worker 内的加载方式、无文件系统时如何喂入 `seas_18.se1`、冷启动与单次计算耗时。

仅当以上走不通时，才退到 `astronomy-engine`（MIT，纯 JS）+ 自实现 Placidus 宫位，并重新确定容差。

### 3.4 Swiss Ephemeris 授权（已定）

- **方案**：购买 Swiss Ephemeris Professional License（Astrodienst），不走 AGPL。
- **时机**：**对外上线前完成**。许可条款要求在开通公共服务之前选定授权模式，开发与内部验证不受影响。
- **费用**：合同模板（2026 年 9 月版）列的是 700 CHF、不限项目数、有效期 6 年；下单前在 astro.com 价格页核对，并留意期满续期条款。
- **上线检查项**：合同已付款并收到对方会签件，才允许挂公网域名。

---

## 4. `apps/api`（唯一的 Worker）

### 4.1 技术栈

- `Hono` + `Drizzle ORM`（`drizzle-orm/d1`）+ `drizzle-kit`（迁移全部由它生成，不手写 SQL）。
- `Better Auth` + `@better-auth/stripe`。登录方式：**Google OAuth**。不做密码登录（密码哈希在 Workers 上有 CPU 时限风险，且需要自建找回流程）；邮箱验证码登录需要接邮件服务，推迟。
- `ai`（Vercel AI SDK）+ 两个模型适配器，见 §4.6。
- 静态资源：`wrangler.jsonc` 的 `assets` 指向 `apps/web` 的构建产物，`/api/*` 先进 Worker，其余路径回落到 SPA。`apps/web` 建好后再加这段配置。
- 依赖已升到 2026-11 的当前版本（`ai@7`、`zod@4`、`better-auth@1.7`、`stripe@23`、`typescript@7`）。

### 4.2 D1 表结构

**由 Better Auth 生成，不手写、不改名：**

- `user`、`session`、`account`、`verification`（认证）
- `subscription`（Stripe 插件：`plan`、`status`、`periodStart`、`periodEnd`、`stripeSubscriptionId` 等；`status` 接受 Stripe 的全部取值，不加 CHECK）
- `user.stripeCustomerId`

**业务表（Drizzle schema 定义，所有 `user_id` 外键均 `ON DELETE CASCADE`）：**

```text
usage
  user_id       TEXT PK → user.id
  period_start  TEXT NOT NULL        -- 当前配额周期起点
  used          INTEGER NOT NULL

profiles
  id, user_id → user.id, name, birth_datetime, location_name,
  latitude, longitude, timezone (IANA), gender, created_at, updated_at
  INDEX (user_id)

locations_cache
  query_key PK, display_name, latitude, longitude, timezone, created_at

products
  slug PK, title, min_tier, is_published,
  system_prompt, model_name, allowed_tools_json, updated_at

chat_sessions                         -- 不叫 sessions，避免与 Better Auth 的登录会话混淆
  id PK, user_id → user.id, product_slug, profile_id → profiles.id,
  frozen_prompt, frozen_model, frozen_tools_json, created_at
  INDEX (user_id, created_at)

messages
  id PK, session_id → chat_sessions.id (CASCADE), role,
  parts_json TEXT NOT NULL,           -- AI SDK UIMessage parts：文本 + 工具调用 + 工具结果
  created_at
  INDEX (session_id, created_at)
```

- 档位不单独存：`tier` 由 `subscription` 推导（存在 `active` / `trialing` 的订阅则取其 `plan`，否则 `free`）。
- 配额上限不存库：`packages/shared` 里的常量 `QUOTA_LIMIT[tier]`。
- 会话创建时冻结 prompt、model、工具列表三项，之后改商品配置不影响进行中的会话。
- `messages.parts_json` 保存排盘工具结果，多轮对话不重算。
- 第一阶段商品维护：用 SQL 或 Drizzle Studio 直接改 `products` 表；Preset 由一个导入脚本写入。

### 4.3 配额：惰性重置，无 Cron

- **扣减单位**：每次 `POST /api/chat` 请求（一条用户消息）扣 1。
- **周期起点**：付费档取 `subscription.periodStart`；Free 档取当前 UTC 自然月 1 日。
- **一条语句完成重置 + 扣减**（`changes = 0` 即配额用尽，返回 402）：

```sql
INSERT INTO usage (user_id, period_start, used) VALUES (?1, ?2, 1)
ON CONFLICT (user_id) DO UPDATE SET
  used = CASE WHEN usage.period_start < excluded.period_start THEN 1 ELSE usage.used + 1 END,
  period_start = excluded.period_start
WHERE usage.period_start < excluded.period_start OR usage.used < ?3;  -- ?3 = QUOTA_LIMIT[tier]
```

- **失败退还**：模型在产出首个 token 前报错，则 `used = used - 1`。产出后的中断不退。
- **测试**：这条语句涉及收费，配一个针对本地 D1 的测试，覆盖三种情况：跨周期重置为 1、达到上限后拒绝、同一用户并发请求不超扣。

### 4.4 接口

除 `/api/auth/*` 与 `GET /api/catalog` 外，全部要求登录。

| 路径 | 说明 |
| --- | --- |
| `/api/auth/*` | Better Auth 接管（登录、登出、删除账号、Stripe Checkout、Customer Portal、Webhook） |
| `GET /api/me` | 用户信息、`tier`、本期已用/上限 |
| `GET /api/me/export` | 导出本人全部数据（档案、会话、消息）为 JSON，见 §8 |
| `GET /api/catalog` | 已上架商品（不返回 `system_prompt`） |
| `GET/POST/PUT/DELETE /api/profiles[/:id]` | 出生档案 |
| `GET /api/locations?q=` | 城市解析：查 `locations_cache`，未命中调 Open-Meteo Geocoding 并写回 |
| `GET/POST /api/sessions`、`GET/DELETE /api/sessions/:id` | 会话列表、创建（冻结配置）、历史消息、删除 |
| `POST /api/chat` | 流式对话 |

### 4.5 `POST /api/chat` 流程

1. Better Auth 校验登录 → 推导 `tier`。
2. 读取 `chat_sessions`，校验归属；校验商品 `is_published` 且 `tier >= min_tier`。
3. 执行 §4.3 的配额语句。
4. `streamText`：`model = frozen_model`，`system = frozen_prompt`，`tools` = `packages/astrology` 中 `frozen_tools_json` 列出的函数。
5. 返回 AI SDK UI message stream；客户端中止通过请求的 `AbortSignal` 传递，不单设 stop 接口。
6. `onFinish` 中写入 `messages`，用 `ctx.waitUntil` 包住，并消费完流，保证客户端断开后仍然落库。

### 4.6 模型接入：OpenAI 兼容接口 + Gemini API

代码只接两种协议，不绑定具体供应商；用哪家是配置，不是代码（供应商本身待定，见 §7）。

| 前缀 | 适配器 | 覆盖范围 | 配置 |
| --- | --- | --- | --- |
| `openai:` | `@ai-sdk/openai-compatible` | 任何 OpenAI 兼容接口：OpenAI、DeepSeek、Workers AI 的兼容端点等 | `OPENAI_COMPAT_BASE_URL`、`OPENAI_COMPAT_API_KEY` |
| `google:` | `@ai-sdk/google` | Gemini API | `GEMINI_API_KEY`、可选 `GEMINI_BASE_URL` |

- `products.model_name` 的格式为 `前缀:模型名`，例如 `openai:deepseek-chat`、`google:<gemini 型号>`。用 AI SDK 的 `createProviderRegistry` 注册两个适配器，`registry.languageModel(frozen_model)` 直接解析，不写自己的路由代码。
- 同一时间 `openai:` 只指向一个兼容端点。需要同时用两家 OpenAI 兼容供应商时，再加第二个前缀。
- 两个 base URL 都指向 **CF AI Gateway** 的对应路径，由它统一记录请求、token 与成本；不想经过 Gateway 时改 base URL 即可。
- 换模型：改 `products.model_name`。换供应商：改 base URL 与密钥。两者都不动代码，已开始的会话因 `frozen_model` 不受影响。

---

## 5. `apps/web`（前端）

`frontend-v2` **不能整包迁入**：它用 `useExternalStoreRuntime` + 自研 SSE 协议，并依赖旧后端约 75 个接口路径，这些在新后端都不存在。新后端不兼容旧契约，前端数据层按 §4.4 重写：

| 部分 | 处理 |
| --- | --- |
| UI 组件、样式、`@assistant-ui/react` 界面（非 admin 部分约 4200 行 TSX） | 保留；`R1*` 组件中绑定旧会话模型的部分需要改 props |
| `src/runtime/useAstrologyRuntime.tsx`、`src/lib/r1SessionApi.ts` | 删除，改用 assistant-ui 的 AI SDK runtime 对接 `/api/chat` |
| `src/lib/api.ts`、`loginPopup.ts`、`internalIdentityApi.ts`、`/api/r1/auth/*` | 删除，改用 Better Auth 客户端 |
| `src/types/api*.generated.ts` | 删除，类型从 `packages/shared` 导入 |
| `src/admin/`（约 2600 行） | 第一阶段不迁移 |
| 新增 | 页脚的隐私政策 / 服务条款链接、AI 生成内容提示、账号设置里的「导出数据」「删除账号」，见 §8 |

Phase 0 用一个返回固定流的 `/api/chat` 桩验证 assistant-ui 当前版本与 AI SDK 7 的流协议能否直接对接。

---

## 6. 推迟项（出现具体需求再做）

| 项 | 触发条件 | 做法 |
| --- | --- | --- |
| Admin 界面 | 有不写 SQL 的运营同事需要改商品 | `/admin/*` 与 `/api/admin/*` 置于 Cloudflare Access 之后；Worker 端校验 `Cf-Access-Jwt-Assertion`（签名 + AUD），不信任 `Cf-Access-Authenticated-User-Email` 请求头；`workers_dev: false`，只挂自定义域名；试跑流量在 `cf-aig-metadata` 中标记 `admin-preview` |
| 其余排盘技法 | 某个商品需要 | 从 `chart.py` / `astrology_methods.py` 移植，以对应黄金用例验收 |
| 对外 Remote MCP | 有外部客户端（Claude / Cursor）要接入 | 薄壳包一层 `packages/astrology`，用 `agents` 的无状态 handler，不用 Durable Object；鉴权用 `@cloudflare/workers-oauth-provider` + Rate Limiting |
| Langfuse | 需要 Prompt 版本对比或质量评估 | AI SDK telemetry → Langfuse；同步更新隐私政策的处理方清单 |
| PostHog | 需要漏斗分析 | 前端 + API 埋点；**届时必须加 Cookie 同意弹窗**（§8） |
| 邮箱验证码登录 | 有相当比例用户没有 Google 账号 | Better Auth email OTP + 邮件服务 |
| KV 缓存 | D1 读成为瓶颈 | 给 `products`、`locations_cache` 加读缓存 |

---

## 7. 待决策项

1. **模型供应商（阻塞上线，不阻塞开发）**：代码已按 §4.6 接好 OpenAI 兼容接口与 Gemini API，开发期间用任意一家即可。上线前要定下生产用哪家、哪个型号，因为它决定隐私政策的处理方与跨境传输段落（§8.2）。候选与各自的合规含义：
   - **Gemini API**：处理方为 Google（登录已经用到 Google）。需确认使用付费档，免费档的数据使用条款不同。
   - **Workers AI 的 OpenAI 兼容端点**：由 Cloudflare 托管开源模型，不新增处理方。
   - **OpenAI**：新增一家美国处理方。
   - **DeepSeek 官方 API**：数据发往中国境内处理；面向欧盟/英国用户时属于向第三国传输个人数据，披露与合同安排最重。

   选型依据在 Phase 0 产出：用 3 个 Preset 在候选模型上各跑一遍，比较解读质量、工具调用稳定性与单次成本。
2. **界面与 Prompt 语言**：现有 Preset 是中文。面向海外华人可直接复用；面向英语用户需要翻译 Preset 并做前端 i18n，不在本文档范围内。

---

## 8. 合规（海外上线）

以下是工程视角的清单，不是法律意见；隐私政策与服务条款的文本上线前应由律师审阅。

### 8.1 需要写代码的

| 项 | 做法 |
| --- | --- |
| 删除账号 | 启用 Better Auth 的删除用户功能；删除前在钩子里取消 Stripe 订阅；业务表靠 `ON DELETE CASCADE` 清理。前端账号设置里提供入口 |
| 数据导出 | `GET /api/me/export` 返回本人档案、会话、消息的 JSON |
| 删除单个档案与会话 | `DELETE /api/profiles/:id`、`DELETE /api/sessions/:id` |
| AI 提示 | 对话界面明确标注内容由 AI 生成 |
| 占星免责 | 页脚与首次对话前提示：内容仅供娱乐与自我探索，不构成医疗、法律、财务或心理健康建议。同一句写进每个 Preset 的 system prompt，让模型遇到相关问题时引导用户寻求专业帮助 |
| 年龄 | 注册时勾选确认已满 18 岁，写入服务条款 |
| 法律页面 | `/privacy`、`/terms` 两个静态页，页脚与登录页链接 |

### 8.2 需要写进隐私政策的

- **收集的数据**：Google 账号的邮箱与姓名；用户填写的出生时间、出生地、性别（含亲友档案）；对话内容；Stripe 订阅状态。不存储卡号。
- **处理方清单**：Cloudflare（托管、数据库、AI Gateway 日志）、Google（登录）、Stripe（支付）、Open-Meteo（城市解析，仅发送地名查询），以及 **§7 第 1 项选定的模型供应商**（收到出生信息与对话内容）。
- **跨境传输**：按选定的模型供应商所在地如实披露；选定前这一段不能定稿。
- **保留期限**：账号数据保留到用户删除为止；AI Gateway 日志包含出生信息与对话内容，在 Cloudflare 控制台设置日志保留期（建议 30 天）并写明。
- **用户权利**：访问、导出、更正、删除的方式，以及联系邮箱。
- **亲友档案**：用户录入他人出生信息时，由用户承诺已获对方同意，写入服务条款。

### 8.3 Stripe 与订阅

- 启用 Stripe Tax，由 Checkout 自动计算并代收各地区的增值税/销售税；达到注册门槛的地区需要完成税务登记。
- Checkout 开启「同意服务条款」勾选，并链接到 `/terms`。
- 服务条款写明自动续订、取消方式（Customer Portal）与退款政策；欧盟消费者对数字服务有 14 天撤回权，要么支持退款，要么在购买时取得「立即开始服务并放弃撤回权」的明确同意。
- 续订前通知、订阅确认邮件使用 Stripe 自带的邮件功能。

### 8.4 Cookie

第一阶段只有登录所必需的会话 Cookie，没有分析或广告 Cookie，不需要同意弹窗，在隐私政策里说明即可。接入 PostHog 等分析工具时必须加弹窗。

### 8.5 上线检查清单

- [ ] Swiss Ephemeris Professional License 已付款并收到会签件（§3.4）
- [ ] 生产用的模型供应商与型号已定，`products.model_name` 与密钥已配置，隐私政策的处理方与跨境传输段落与之相符（§7）
- [ ] 隐私政策、服务条款已由律师审阅并上线
- [ ] 删除账号与数据导出实测通过，删除后 D1 中无残留、Stripe 订阅已取消
- [ ] Stripe Tax 已启用，Checkout 带条款勾选
- [ ] AI Gateway 日志保留期已设置
- [ ] 自定义域名已绑定

---

## 9. 实施顺序与工期

按纵向切片推进：先打通一条最细的端到端链路，再逐步加宽，避免到最后才第一次联调。工期为一人全职的粗略估算，合计约 5–6 周。

各阶段的截止日期、依赖白名单、平台绑定白名单与代码行数预算记在根目录的 `boundaries.json`，由 `npm run check` 强制；工作规则见 `agent.md`，界面范围见 `docs/DESIGN.md`。§6 的推迟项要启用时，必须先在 §6 写明触发条件，再由负责人修改 `boundaries.json`。

| 阶段 | 估算 | 内容 | 完成标准 |
| --- | --- | --- | --- |
| **Phase 0 风险验证** | 3 天 | §3.3 的三项验证；导出东占基准（§3.2）；前端流协议桩（§5）；确认 Workers Static Assets 的配置方式；候选模型对比（§7） | `natal_A` 在 Worker 内算出且与黄金集一致；桩页面能显示流式回复；有一份候选模型对比结果 |
| **切片 1：最细链路** | 1.5 周 | Google 登录 → 建一个档案 → `natalWheel` → `/api/chat` 一轮对话 → 前端显示。含 Drizzle schema、迁移、`apps/web` 骨架 | 本地与线上预览环境都能走通全流程 |
| **切片 2：排盘补全** | 1 周 | 其余 3 个工具；§3.2 的西占与东占用例全部通过；Preset 导入脚本；会话列表与历史 | 测试脚本全绿；3 个 Preset 可用 |
| **切片 3：配额与订阅** | 1 周 | §4.3 配额与测试；Stripe Go/Pro 计划、Checkout、Customer Portal、Webhook | 配额测试通过；测试模式下完成升级、续订、取消 |
| **切片 4：前端补全** | 1 周 | 档案管理、商品目录、城市搜索、排盘事实展示组件；账号设置（导出、删除） | 旧前端的 C 端功能在新前端都可用 |
| **上线准备** | 3 天 | §8.5 检查清单 | 清单全部勾完 |

脚手架已对齐本文档（依赖版本、`wrangler.jsonc`、`packages/astrology`、`.env.example`、README）。三个 workspace 目前都没有 `src/`，`npm run typecheck` 会失败，切片 1 起解决。
