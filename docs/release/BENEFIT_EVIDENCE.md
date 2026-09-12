# Benefit evidence / 收益证据

## Result

In one real, short DeepSeek Harness task family, approving and delivering the matched Experience reduced measured provider token volume from **629,972 to 214,554 (-65.9%)**, tool calls from **33 to 18 (-45.5%)**, model steps from **13 to 7 (-46.2%)**, and elapsed time from **52.6 s to 26.5 s (-49.6%)**. Both runs completed the same read-only acceptance task successfully.

在一个真实、短时的 DeepSeek Harness 任务族中，批准并注入匹配经验后，测得的 provider token volume 从 **629,972 降到 214,554（-65.9%）**，工具调用从 **33 降到 18（-45.5%）**，模型步骤从 **13 降到 7（-46.2%）**，用时从 **52.6 秒降到 26.5 秒（-49.6%）**。两次运行都正确完成了同一个只读验收任务。

This is an observed result, not a promised saving rate. It is one paired task family with stochastic model behavior. It demonstrates that the approved Context path can remove repeated exploration; it does not establish an average across repositories, providers, task types, or users.

这是一次观测结果，不是节省比例承诺。样本只有一个配对任务族，模型本身具有随机性；它证明“正确经验经批准进入 Context 后能够减少重复探索”，不能代表所有代码库、模型、任务类型或用户的平均收益。

## Task and intervention

The exact task was intentionally bounded:

> Read-only accept the current DeepSeek Harness host for Experience Map: verify the Harness version, shared `/api` Fetch plugin route, asynchronous `readSession` and v3 Session events, and confirm that the tracked worktree remains unchanged. Provide evidence paths and do not modify files.

The two primary comparison runs used the same Harness checkout, DeepSeek route, headless profile, tools, read-only permissions, task text, and saved Experience:

| Run | Experience state | Provider token volume | Model steps | Tool calls | Time | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| B2 control | Matched, Plan not approved, no Context | 629,972 | 13 | 33 | 52.6 s | Passed; repeated the investigation |
| B3 treatment | Same match, Plan approved, Context delivered | 214,554 | 7 | 18 | 26.5 s | Passed; reused the verified route |

The intervention was Experience Context delivery after Plan approval. Automatic tool execution stayed disabled. Separate API keys were not needed because every model step and token event was attributed to its Session.

## Measurement

`provider token volume` is:

```text
uncached input + cache reads + cache writes + output tokens
```

It measures provider traffic recorded by the Session projection. It is not a bill: providers price cached and uncached tokens differently. Model steps, tool calls, elapsed time, match disposition, approval, and Context delivery were read from the same Session/Experience runtime evidence.

The empty-database baseline used 728,159 provider-token units. The treatment was 70.5% lower than that baseline, while the stricter B2/B3 comparison above isolates approval and Context delivery in the already-installed Experience environment.

## Evidence files

- [`benefit-pilot.json`](../../evidence/release/benefit-pilot.json) contains the de-identified run table, formulas, environment controls, and non-claims.
- [`benefit-pilot.events.jsonl`](../../evidence/release/benefit-pilot.events.jsonl) contains the de-identified lifecycle and measurement events for each run.
- [`current-build-validation.json`](../../evidence/release/current-build-validation.json) binds the later semantic-formation/recall repair to installed, packed, Browser, and frozen-evaluation readbacks.

Raw Session bodies are deliberately not published because they contain user content and absolute local paths. The private source record is integrity-bound by SHA-256 in `benefit-pilot.json`; maintainers can audit it privately without making it part of the public repository.

## What remains unproven

- A stable mean or percentile saving across multiple task families.
- Direct currency savings for any provider price schedule.
- Benefit when the Experience is wrong, stale, not approved, or not recalled.
- Generalization to other Harness versions, models, repositories, permissions, or languages.

Release claims must therefore say “observed 65.9% lower provider token volume in one real paired task,” never “saves 65.9%” without the qualifier.
