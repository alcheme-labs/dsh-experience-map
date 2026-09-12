# Experience Map 五分钟上手

Experience Map 会在 DeepSeek Harness（DSH）完成任务后，本地检查最近的 Session，按会话列出值得保存的经验建议；用户明确保存后，它才会成为可召回的 Experience。相同经验只对应一个 Experience Series，重复出现会补充证据，不会重复保存一份内容。

## 1. 安装

从 npm 安装无 scope 的 `0.1.0-beta.3` 包，安装时不需要在本机执行仓库里的构建脚本：

```sh
dsh plugin --profile web add dsh-experience-map@0.1.0-beta.3
```

然后启动 Web Profile：

```sh
dsh web
```

如果从 DSH 源码运行命令，把上面的 `dsh` 换成 `pnpm dsh`。如果希望自行构建，请克隆本仓库并运行 `pnpm install && pnpm run build && pnpm pack`。本预发布版本要求 DSH `0.1.5-rc.2`，Node.js `^22.19.0` 或 `>=24.0.0`。

## 2. 收集第一条建议

1. 在 DSH 中完成一个包含真实执行结果的任务，例如修复一个测试失败并重新运行测试确认成功。
2. 打开当前会话的“经验”标签页。
3. 查看“最近会话”中的建议。界面会直接显示建议类型、保存条件和证据状态；用户不需要先选择六种 Experience 类型。
4. 对 `可保存` 的建议点击“保存为经验”。`需完善` 或 `需审阅` 不会被悄悄保存。

安装后不需要先打开设置：`automaticSuggestionDetection` 默认开启，只检查最近 8 个 Session，未处理建议 14 天后可以被丢弃。完整 Session 仍保留在 DSH 本地；自动检测、分组和默认召回不会调用外部模型。

## 3. 在相似任务中复用

1. 提交一个与已保存 Experience 作用域和前置条件相符的新任务。
2. Experience Map 会自动运行保守召回；证据不足、作用域不同或第一名不够明确时，它会选择不匹配。
3. 打开“经验”标签页，检查当前 Preflight 和精确 Plan。
4. 明确批准 Plan 后，下一次完全相同的任务才会消费一次性绑定并获得最小 Experience Context。

`automaticRecall` 默认开启，但 `defaultMustUseExperience` 默认为 `false`；匹配不会强迫 Agent 使用经验。自动工具执行始终关闭，批准 Experience Plan 也不等于批准任何工具操作。

## 4. 设置哪些内容

常规使用只需要确认以下四项：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| 自动检测建议 | 开启 | 从最近完成的 Session 生成可丢弃建议。 |
| 自动召回 | 开启 | 对新任务进行保守匹配，允许不匹配。 |
| Context 注入 | Plan 获批后 | 未批准不注入。 |
| 自动工具执行 | 关闭 | Experience Map 不替用户授权工具。 |

需要修改时，打开“设置 → 插件 → 插件配置 → Experience Map”。本地向量模型和外部 Candidate 提炼都是可选项，不是自动收集与默认召回的前置条件。

## 5. 终端与 headless 使用

安装到 headless Profile 后，Session 建议检测和 Experience 召回同样默认开启：

```sh
dsh plugin --profile headless add dsh-experience-map@0.1.0-beta.3
dsh --profile headless "检查当前项目的测试并修复同类失败"
```

终端没有“点击保存”操作，因此保存、忽略和 Plan 批准仍通过显式管理命令完成。先创建独立管理 Profile：

```sh
dsh plugin --profile experience-management add dsh-experience-map@0.1.0-beta.3
```

把下面两行追加到 `$DSH_HOME/profiles/experience-management/cordis.patch.yml`；不要覆盖其中已有的用户配置：

```yaml
- insert:
    - id: experience-map-cli-startup
      name: 'dsh-experience-map/cli/startup'
    - id: experience-map-cli-runner
      name: 'dsh-experience-map/cli/runner'
```

然后读取权威状态：

```sh
dsh --profile experience-management experience status
dsh --profile experience-management experience suggestions-show
dsh --profile experience-management experience plan-list
```

保存命令接收一个 JSON 文件，而不是凭模糊标题操作。先从 `suggestions-show` 复制目标分组的 `suggestionGroupId`、`revisionDigest`、`reviewDigest` 和 `sourceDigest`，再提交：

```json
{
  "commandId": "<NEW_UUID>",
  "suggestionGroupId": "<GROUP_ID>",
  "expectedRevisionDigest": "<REVISION_DIGEST>",
  "reviewDigest": "<REVIEW_DIGEST>",
  "sourceDigest": "<SOURCE_DIGEST>",
  "correlationId": "manual-cli-save",
  "causationId": null,
  "issuedAt": "<CURRENT_ISO_8601_TIME>"
}
```

```sh
dsh --profile experience-management experience suggestion-save --input /absolute/path/to/save-suggestion.json
```

如果建议在提交前已经变化或过期，版本摘要校验会拒绝保存；重新读取建议后再决定。CLI 是可审计的管理接口，不会把“开启自动保存”变成无人确认的持久写入。

## 6. 怎么确认真的生效

- `suggestions-show` 能看到新 Session 和对应建议分组。
- 保存返回 `saved_new_experience`、`attached_as_evidence` 或 `already_recorded` 之一；后两者都不会新建重复 Experience。
- `plan-list` 能看到相似任务的 Match、Preflight、Plan 和批准状态。
- 获批后的实际任务请求包含最小 Experience Context；未批准任务不包含。
- “设置 → 插件”中的有效值仍显示自动执行关闭。

更完整的产品边界、隐私说明和内部生命周期见[中文 README](../README.zh.md)。
