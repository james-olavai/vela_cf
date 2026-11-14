# agent.md — 在本仓库工作的规则

适用于所有在这里写代码的人和 AI 代理。目标只有一个：**在 2026-12-24 前，用最少的代码把第一阶段做上线。**

## 先读这三份

| 文件 | 管什么 |
| --- | --- |
| `docs/LLD.md` | 架构、Firestore 结构、Cloud Functions、合规、排期 |
| `docs/DESIGN.md` | 页面、交互、设计变量 |
| `boundaries.json` | 机器强制的边界：workspace、依赖、平台绑定、代码行数、函数数、排期 |

三份文件之外没有需求。文档没写的功能就是不做的功能。

## 项目是什么

基于 Firebase / Google Cloud（`asia-southeast1`）的全栈 TypeScript 应用：Firebase Hosting 托管 React 前端（`apps/web`），Firestore 存数据，Cloud Functions 2nd gen（`apps/api`，Genkit `onCallGenkit`）调用 `packages/astrology` 的四个排盘纯函数，通过 Vertex AI 将结果交给 Gemini 流式对话。Firebase Auth（Google 登录），Run Payments with Stripe 扩展管理三个档位。

## 硬边界（`npm run check` 强制）

- **workspace 只有四个**：`apps/api`、`apps/web`、`packages/astrology`、`packages/shared`。
- **依赖是白名单**：不在 `boundaries.json` 里的包不能装。
- **平台能力是白名单**：`firebase.json` 只允许 `firestore`、`functions`、`hosting`、`emulators`、`extensions`、`remoteconfig`，区域固定 `asia-southeast1`。Cloud SQL / Data Connect、Cloud Storage、Pub/Sub、Cloud Tasks、定时任务都不允许。
- **代码行数有预算**：`apps/api` 2000，`apps/web` 5000，`packages/astrology` 2500，`packages/shared` 300（`src/` 下，不含测试）。超了先删再加。
- **Cloud Functions 不超过 6 个**：清单见 LLD §4.4。
- **AI 工具与安全是硬边界**：`defineTool` 最多 4 个（对应 4 个排盘纯函数），定义 Tool 的文件严禁引入 `firebase-admin`、`stripe` 或调用 `fetch`（锁死 Prompt 注入爆炸半径为 0）；`firestore.rules` 严禁出现 `allow write: if true`。

`boundaries.json` 的 `deferred` 列出了已明确推迟的东西，LLD §6 写了各自的触发条件。触发条件没出现，就不做。

## 怎么写代码

1. **先问需不需要。** 为「以后可能用到」写的代码一律不写。
2. **先找现成的。** 顺序：本仓库已有的 → 语言与平台自带的 → 已安装依赖与 Firebase 扩展提供的 → 最后才自己写。
3. **不做抽象。** 只有一个实现就不写接口，只有一个产品就不写工厂，不会变的值就不做配置项。同样的代码出现第三次再提取。
4. **不分层。** `apps/api` 不要 controller / service / repository 三层，函数处理逻辑里直接用 `firebase-admin/firestore` 读写。不要依赖注入容器、事件总线、插件机制。
5. **不自建基础设施与中台。** 认证与用户中台用 Firebase Auth Console，Prompt 中台用 Firebase Remote Config (Server)，商品与订阅中台用 Firestore Console + Stripe Dashboard + `Run Payments with Stripe` 扩展，删号清理用 `Delete User Data` 扩展，站点分析用 `firebase/analytics`（GA4），流式与工具调用用 Genkit。不要包一层「自己的」封装或自建后台。
6. **前端同理。** 不引入路由库、状态管理库、组件库、表单库。五个页面用 `location.pathname` 分支，状态用 React 自带的，只读数据用 Firestore `onSnapshot` / `getDocs`，表单用原生元素。
7. **测试只测要紧的。** 必须有的只有两个：排盘黄金集比对、Firestore 配额事务并发测试。用 `node:test` 和 Firebase Emulator，不装第三方测试框架。不追求覆盖率。
8. **故意走的捷径要留记号**：`// ponytail: <上限是什么>，<什么时候升级>`。
9. **不写计划、决策、分析类文档。** 结论写进 LLD 或 DESIGN 的对应章节。

不能省的：对外入口的输入校验与 Firestore Security Rules、LLM 防注入护栏（LLD §4.6：单条消息 `<= 2000` 字、`system` 角色隔离、`maxTurns: 3`、Tool 零副作用）、防止丢数据的错误处理、鉴权与归属校验、LLD §8 的合规项、DESIGN §5 的可访问性。

## 想越界的时候

不要改 `boundaries.json` 让检查通过。正确的流程：

1. 在 LLD §6 的推迟项表里写明：要加什么、触发条件是什么、现有方案为什么不够。
2. 项目负责人批准。
3. 由负责人（或经其确认）修改 `boundaries.json`，同一次提交里完成。

AI 代理遇到边界检查失败时：撤回越界的改动，换一个不越界的做法；做不到就停下来向人说明，不要自行放宽边界。

## 排期

| 阶段 | 截止 | 完成标准 |
| --- | --- | --- |
| Phase 0 风险验证 | 2026-11-18 | `natal_A` 在 Functions 内算出且与黄金集一致；前端桩页面显示 Genkit 流式回复；定下默认 Gemini 型号 |
| 切片 1 最细链路 | 2026-11-30 | 登录 → 建档案 → 本命盘 → 一轮对话，本地 Emulator 与线上预览都走通 |
| 切片 2 排盘补全 | 2026-12-07 | 四个工具的基准用例全绿；3 个 Dotprompt Preset 可用 |
| 切片 3 配额与订阅 | 2026-12-14 | 配额事务测试通过；Stripe 扩展测试模式完成升级、续订、取消 |
| 切片 4 前端补全 | 2026-12-21 | DESIGN §2 的页面全部可用，删号与导出实测通过 |
| 上线准备 | 2026-12-24 | LLD §8.5 检查清单全部勾完 |

日期按一人全职、2026-11-16 开工推算，记在 `boundaries.json` 的 `schedule` 里。

- 一个阶段完成后，把 `boundaries.json` 里对应的 `done` 改为 `true`。
- **逾期时砍范围，不延期、不加功能。** 优先砍的顺序：追问建议 → 星盘事实栏的「查看全部」→ 最近的咨询 → 手机版的抽屉交互。
- 当前阶段之外的工作不提前做。

## 常用命令

```bash
npm run check        # 边界与排期检查
npm run typecheck    # 类型检查
npm run dev:api      # 本地启动 Firebase Emulators
```

## 上线阻塞项

不由工程决定，但没完成不能上线：Swiss Ephemeris 商业授权（LLD §3.4）、生产用的 Gemini 型号定稿（LLD §7）、隐私政策与服务条款的法务审阅（LLD §8）。
