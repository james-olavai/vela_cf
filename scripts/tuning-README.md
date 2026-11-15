# Vela 占星师调优工作区

这个目录用于在自己的 AI harness 中修改解读方式、运行真实 Vela 案例并提交候选版本。安装时需要 Node.js 22 和 npm；工程人员完成一次连接后，占星师通过自然语言操作。

新 harness 先读 [AGENTS.md](AGENTS.md)；调优流程见 [.agents/skills/vela-prompt-tuning/SKILL.md](.agents/skills/vela-prompt-tuning/SKILL.md)。支持仓库 skill 发现的 harness 可直接使用 `vela-prompt-tuning`，其他 harness 按文件路径读取即可。小写 `agent.md` 是同一规则的索引。

## 安装与连接

1. 将本目录保存为私有仓库，其他协作者克隆该仓库。
2. 在目录中运行 `npm ci`，然后运行 `npm run setup`。
3. 将 `.env.example` 复制为 `.env`，填写本人可访问的模型网关地址和令牌。凭据仅保存在本机。
4. 将 setup 生成的 MCP 配置加入 harness；每台电脑、每次移动目录后重新运行 setup。
5. 在 harness 中要求“列出 Vela 产品和测试案例”，随后选择案例查看初始上下文。

模型连接与生产应用分开：本地运行时包含与产品共用的排盘、路由、上下文和护栏代码，通过网关调用被测模型，无需生产 Firebase 登录。当前适配器仅支持 `gemini-4-hydrogen`，需要兼容 `/v1/chat/completions` 且支持工具调用的网关。地址填至 `/v1`，不包含 `/chat/completions`。本地没有模型推理服务，首次真实运行会产生模型费用。

## 用自然语言调优

向 harness 说明：“用北京案例测试这个问题。回答需要直接、客观、少用术语。先提出修改，再运行同一案例比较。”

harness 负责编辑 `prompts/`、说明变化；MCP 调用固定版本 Vela 运行时和目标模型。每次启动评测固化当前文本快照；修改文件不会影响已启动的任务。使用 `inspect_product` 查看产品、案例、配置或初始请求；`start_evaluation` 返回任务 ID；用 `get_evaluation` 读取进度与结果。通过 `cancel_evaluation` 取消任务，已发生费用无法撤销。

比较前保留基线评测，再修改文件运行候选。`compare_evaluations` 检查模型、案例与运行条件，返回回答供人工判断；当前 A/B 标签未随机，不是严格双盲。静态 Prompt 文件与初始预览也不是模型后续每轮的完整上下文。

编辑模型可以是用户自己的任意 harness 模型。正式回答由 MCP 使用指定目标模型生成；其他模型上的改善只能作为候选证据。模型型号、运行时、工具模式与预算不同的结果不可宣称等价。Hydrogen 不支持温度调节；这里的本地输出预算不能代替生产配额验证。

## 文件与版本

- `prompts/`：可调文本和产品资源清单。
- `cases/`：合成档案、固定问题与盘面资源；引擎自产盘面不是独立天文黄金值。
- `runtime/`、`runtime.lock.json`：固定版本执行代码与完整性信息；升级由工程人员交付新版本，调优时不编辑。
- `.vela/`：本地任务与原始结果，已忽略，不提交。
- `reports/`：人工审核、脱敏后的报告，随 Prompt 提交 PR。

模型凭据、真实个人资料、原始 trace 不提交。提交 Prompt 与报告不代表发布到生产；代码维护者审核后验证测试环境，发布完整配置并核验生效哈希。原始回答仍需人工核对盘面事实、问题相关性、客观性与行动建议。

生产未部署本地候选；生产使用的 Prompt 版本应以发布环境核验记录为准。本仓库首次交付是候选版本，不应将 runtime 的来源提交号理解为它已部署。
