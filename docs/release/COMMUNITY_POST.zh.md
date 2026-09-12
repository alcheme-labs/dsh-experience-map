# DSH 社区发布稿

目标分类：[Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins)

建议标题：

> DSH｜Experience Map｜让 Agent 复用经过验证的经验，减少重复探索

建议正文：

> **非官方社区插件，由社区成员独立开发和维护，不代表 DeepSeek 官方产品、审核或推荐。**

项目地址：https://github.com/alcheme-labs/dsh-experience-map

Experience Map 是一个面向 DeepSeek Harness 的本地优先经验插件。它要解决的是：同类任务每次执行路线不稳定，Agent 重复尝试已经失败过的步骤，造成额外模型调用、工具调用和 Token 消耗。

它会在任务完成后本地检查最近的 Session，把有证据支撑的 Procedure、Diagnostic、Preference、Fact 等建议按会话列出。用户明确保存后，建议才成为不可变、可版本化的 Experience；相同经验跨会话重复出现时只补充证据，不重复保存内容。新任务召回时还要通过作用域、前置条件、当前 Preflight、阈值和排名间隔检查，不确定就不匹配。

与 DSH 的集成方式：

- 作为标准 `dsh.bundle` 安装到现有 Web 或 headless Profile，不修改 DSH 源码。
- Web 端嵌入现有会话的“经验”标签页，并在“设置 → 插件”提供配置卡片。
- Host 负责唯一的 Experience 写入、保守召回、Plan、验证与结算；完整 Session、模型路由、工具和审批仍由 DSH 负责。
- 自动建议检测和自动召回默认开启，但保存、Plan 批准和工具批准相互独立；自动工具执行关闭。
- 自动检测、分组和默认召回无需外部模型。可选本地语义模型和外部 Candidate 提炼都由用户单独配置。

快速安装（首发 GitHub Release 的预构建包）：

```sh
dsh plugin --profile web add https://github.com/alcheme-labs/dsh-experience-map/releases/download/v0.1.0-beta.1/alcheme-dsh-experience-map-0.1.0-beta.1.tgz
dsh web
```

使用说明：https://github.com/alcheme-labs/dsh-experience-map/blob/main/docs/QUICKSTART.zh.md

界面截图：https://github.com/alcheme-labs/dsh-experience-map/blob/main/docs/media/experience-map-overview.png

收益证据：在一组短、配对的真实 DSH 任务中，批准并注入同一条匹配 Experience 后，观测到 provider token volume 降低 65.9%、工具调用减少 45.5%、模型步骤减少 46.2%。这只是一个任务族的观测值，不是平均值或节省承诺；任务、控制条件、去标识事件、计算方式和非主张均在仓库的 `docs/release/BENEFIT_EVIDENCE.md` 中公开。

兼容性：DSH `0.1.5-rc.2`；Node.js `^22.19.0` 或 `>=24.0.0`；MIT License。

维护：杭州星原驱动科技有限公司 · OPC（超级个体）实践。

欢迎用真实、短任务体验后反馈：错误匹配、应该召回但未召回、Suggestion 不可理解、终端闭环和实际 Token/工具调用变化，都是我们最关心的问题。
