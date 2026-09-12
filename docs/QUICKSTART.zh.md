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

注意：安装 Experience Map 不会附带或自动下载本地模型。要启用本地稠密检索，需要另行安装可选的 `@huggingface/transformers` 运行时、自行准备固定 revision 的模型目录，并配置本地绝对路径及制品校验信息。插件运行时禁止远程下载；未完成配置或模型不可用时会保留词法召回路径。

## 5. 可选：启用经过评测的本地语义召回

默认模式不需要模型：类型专属作用域、证据、前置条件、风险等确定性硬门先排除不适用经验，MiniSearch 只在剩余候选中做词法排序。这个模式偏向“不确定就不匹配”，因此不能把受控测试结果理解成广泛的中文召回率；明显改写或中英跨语言任务更可能漏召回。

如果希望复现本项目发布前测试的中文改写和跨语言语义路径，请使用下面的**精确运行时、模型 revision 和默认阈值**。

### 5.1 给使用该功能的 Profile 安装可选运行时

Web Profile 可以一次安装插件和可选 peer runtime：

```sh
dsh plugin --profile web add dsh-experience-map@0.1.0-beta.3 @huggingface/transformers@4.2.0
```

如果还要在 `headless` 或 `experience-management` Profile 中运行语义召回，也要把 `@huggingface/transformers@4.2.0` 加到对应 Profile。DSH 可能提示 Transformers.js 不是 DSH Bundle；这是预期提示，它仍作为该 Profile 的普通依赖保留。启用前请阅读[安全说明](../SECURITY.md)。

### 5.2 下载固定模型到持久目录

先按 Hugging Face 的 [`hf` CLI 安装说明](https://huggingface.co/docs/huggingface_hub/main/en/guides/cli)安装 `hf`，然后只下载运行所需的四个文件：

```sh
EXPERIENCE_MODEL_DIR="${HOME}/.local/share/dsh-experience-map/models/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78"
mkdir -p "${EXPERIENCE_MODEL_DIR}"
hf download Xenova/multilingual-e5-small \
  config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx \
  --revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78 \
  --local-dir "${EXPERIENCE_MODEL_DIR}"
shasum -a 256 "${EXPERIENCE_MODEL_DIR}/onnx/model_quantized.onnx"
```

最后一条命令必须输出：

```text
f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193
```

不要把模型放在 `/tmp` 或 `/private/tmp`：系统清理后路径会失效。固定模型版本可在 [Hugging Face revision 页面](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)核对。

### 5.3 在插件设置中启用并读回状态

打开“设置 → 插件 → 插件配置 → Experience Map → 本地语义匹配”：

1. 把“本地语义模型 Provider”改为 `transformers_js`。
2. 把“已校验模型目录”设为上面 `EXPERIENCE_MODEL_DIR` 展开后的**绝对路径**。
3. 其余字段保留安装时的校准默认值，不要只凭感觉调整阈值。

关键默认值应为：

| 字段 | 经过评测的值 |
| --- | --- |
| 模型 / revision | `Xenova/multilingual-e5-small` / `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| 制品 / SHA-256 / 字节数 | `onnx/model_quantized.onnx` / `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193` / `118308185` |
| Tokenizer/配置包 SHA-256 | `4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133` |
| 维度 / dtype / pooling | `384` / `q8` / `mean` |
| query / passage 前缀 | `query: ` / `passage: ` |
| 最大 Token / 相似度门槛 / 第一二名间隔 | `512` / `0.76` / `0.025` |
| 等价候选门槛 / 间隔 | `0.88` / `0.03` |

设置实时生效，不需要重启 Host。尚无已保存 Experience 时，“已配置，等待语料”是正常状态；至少保存一条 Experience 并等待索引完成后，状态必须变为“语义索引可用”。如果显示“模型不可用（已降级词法）”，不要把后续结果当作本地 E5 测试结果，应先核对 Profile 依赖、绝对路径、revision 和摘要。

当前自动稠密适用性和语义等价只对 `procedure`、`diagnostic` 两类开放；这是评测校准边界，不是遗漏设置。Preference、Fact、Strategy、Causal 等类型不会只凭 E5 高分越过确定性硬门。

本次固定模型目录约 129 MB；一次 macOS arm64 基准中，量化制品为 118,308,185 字节，首次加载约 739 ms、热查询 p95 约 9.7 ms、进程 RSS 增量约 576 MiB。这些资源数值只用于容量预估，不是所有机器的性能承诺。

### 5.4 测试结果到底用了什么

- 默认 MiniSearch 词法基线在冻结的 12 条受控召回回放中为 12/12、0 harmful match；样本依赖明确的任务族、作用域和错误/工具信号，不能外推成任意中文任务的准确率。
- 本地 E5 混合回放使用 MiniSearch `7.2.0` 加上述固定模型，同一 12 条为 12/12、0 harmful match。
- 108 条完整质量评测不是 108 条纯召回测试：可提炼性、类型和证据落位主要由确定性逻辑负责；本地 E5 参与语义等价、组件映射和适用性测试。该小型冻结集结果为 0 false merge、0 harmful recall/context injection、0 incorrect component evidence；它不是生产总体准确率。
- README 中 65.9% provider token volume 降幅来自同一条已匹配 Experience 在“未批准、未注入”和“已批准、已注入”之间的短任务配对。该试验运行时本地 E5 为 `dense_ready`，但匹配条件在两组中保持一致；它证明 Context 复用收益，不证明 E5 比词法更准。

因此建议是：只要求零依赖和最保守行为时保留默认词法；主要使用中文、存在大量 Procedure/Diagnostic 换说法或跨语言任务时，启用上述固定 E5 配置。设置卡可以填写其他本地 Transformers 模型身份，但当前自动召回会因“未校准”而保守拒绝或降级，不能声称复现了本项目测试效果。当前召回适配器不支持外部向量 Provider；设置中的外部 DSH 模型路线用于 Candidate 提炼，是另一条能力链路。

## 6. 终端与 headless 使用

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

## 7. 怎么确认真的生效

- `suggestions-show` 能看到新 Session 和对应建议分组。
- 保存返回 `saved_new_experience`、`attached_as_evidence` 或 `already_recorded` 之一；后两者都不会新建重复 Experience。
- `plan-list` 能看到相似任务的 Match、Preflight、Plan 和批准状态。
- 获批后的实际任务请求包含最小 Experience Context；未批准任务不包含。
- “设置 → 插件”中的有效值仍显示自动执行关闭。
- 启用本地语义模式时，至少保存一条 Experience 后，“本地语义索引”显示“语义索引可用”；否则当前运行仍是词法路径。

更完整的产品边界、隐私说明和内部生命周期见[中文 README](../README.zh.md)。
