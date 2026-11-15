# Vela 解读文本资源

这里是统一的解读文本资源目录，随独立调优项目保存和交付。当前默认版本为 `consultation-guides-v4`；本目录更新不代表线上已经发布。

- [产品清单](manifest.json)：Free、Go、Pro 与固定模板的映射。
- [共同咨询规范](shared/_consultation.prompt)：直答、中立、普通语言与行动边界。
- [回答结构](shared/output.md)、[资料模板](shared/templates.json)、[技法路由说明](shared/routing.json)。
- [技法索引](references/catalog.json)：各项指南的标题与摘要，正文位于同目录对应 `.md` 文件。
- [工具说明](tools/descriptions.json)：只解释已注册能力，不授予工具或数据访问权限。

在应用代码仓库内，工程人员运行 `npm run prompt:build` 生成固定 TypeScript 产物，运行 `npm run prompt:check` 检查漂移。独立调优仓库按根 README 配置 MCP，修改这些文本后由本地运行时按次编译。生产导入生成产物，不在请求中读取文件或访问 GitHub。构建编译使用已安装的 Genkit Dotprompt 渲染；三档主 Prompt 的消息角色与正文须保持既有值，不能通过模板增加模型调用或工具执行循环。

资源的 `sourceHash` 为目录内容的确定性摘要，`runtimeContractVersion` 表示兼容契约。未提交的修改属于本地候选；合并后也仍须测试发布和人工生产发布，线上版本须通过实际 Remote Config/Bundle 哈希核验。

固定安全尾注由 Vela 运行时代码维护，工具参数 Schema、权限、路由算法、排盘事实序列化和消息数据边界由运行时代码维护。它们是只读运行时资源，不能以改文本绕过。完整可观察上下文仍须结合代码版本、实际工具响应和模型逐轮请求，静态文件本身不是完整上下文。

浏览器旧草稿不会自动迁入本目录。旧 Playground 已按负责人要求删除，调优改用本地 MCP；无代码占星师验收仍待完成。独立项目的合成案例位于根 `cases/`；应用仓库保留原始案例与历史 A/B 证据；原始 trace 与真实个人资料不复制进资源仓库。
