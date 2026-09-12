# Experience Map five-minute quickstart

Experience Map locally inspects recently completed DeepSeek Harness (DSH) Sessions and lists evidence-backed suggestions by Session. Nothing becomes durable Experience memory until the user explicitly saves it. Repeated evidence for the same stable kernel targets one Experience Series instead of creating duplicate content.

## 1. Install

Install the unscoped `0.1.0-beta.3` package from npm; installation does not execute repository build scripts on your machine:

```sh
dsh plugin --profile web add dsh-experience-map@0.1.0-beta.3
```

Then start the Web profile:

```sh
dsh web
```

When running DSH from its source checkout, replace `dsh` with `pnpm dsh`. To build the package yourself, clone this repository and run `pnpm install && pnpm run build && pnpm pack`. This pre-release targets DSH `0.1.5-rc.2` and Node.js `^22.19.0` or `>=24.0.0`.

## 2. Collect the first suggestion

1. Finish a task with a real outcome, such as fixing a failing test and rerunning it successfully.
2. Open the conversation's `Experience` tab.
3. Inspect suggestions under the recent Session. The UI explains type, save readiness, and evidence; the user does not classify six Experience kinds first.
4. Choose `Save as experience` only for a `ready` suggestion. `Needs enrichment` and `needs review` are not silently saved.

No settings change is required first. `automaticSuggestionDetection` is enabled by default, examines the most recent eight Sessions, and may discard unattended suggestions after 14 days. Complete Sessions remain local to DSH. Automatic detection, grouping, and default recall do not call an external model.

## 3. Reuse it in a similar task

1. Submit a new task whose scope and preconditions fit the saved Experience.
2. Experience Map runs conservative recall and abstains when evidence, scope, or ranking margin is insufficient.
3. Open `Experience` and inspect the current Preflight and exact Plan.
4. Only after explicit Plan approval may the next exact task consume a one-time binding and receive minimal Experience Context.

`automaticRecall` is enabled by default, while `defaultMustUseExperience` is `false`; a match never forces the agent to reuse it. Automatic tool execution remains disabled, and approving an Experience Plan does not approve any tool action.

## 4. Settings that matter first

| Setting | Default | Meaning |
| --- | --- | --- |
| Automatic suggestion detection | Enabled | Derive disposable suggestions from recent completed Sessions. |
| Automatic recall | Enabled | Match conservatively and allow no match. |
| Context injection | After Plan approval | Never inject an unapproved Plan. |
| Automatic tool execution | Disabled | Experience Map cannot grant tool authority. |

To change them, open `Settings → Plugins → Plugin configuration → Experience Map`. The optional local vector model and external Candidate proposal route are not prerequisites for automatic collection or default recall.

Installing Experience Map does not bundle or automatically download a local model. To enable local dense retrieval, separately install the optional `@huggingface/transformers` runtime, prepare a model directory pinned to an exact revision, and configure its absolute local path and artifact verification metadata. Remote model downloads are disabled at runtime; lexical recall remains available when the configuration is incomplete or the model is unavailable.

## 5. Optional: enable the evaluated local semantic recall

The default mode needs no model. Type-specific deterministic gates first reject Experiences whose scope, evidence, prerequisites, or risk do not apply; MiniSearch only ranks the remaining candidates lexically. This mode deliberately prefers abstention, so its bounded test result is not broad recall evidence. Paraphrases and cross-language tasks are more likely to be missed.

To reproduce the bilingual and paraphrase-oriented semantic path tested for this release, use the **exact runtime, model revision, and calibrated defaults** below.

### 5.1 Install the optional runtime in every participating Profile

The Web profile can install the plugin and its optional peer runtime together:

```sh
dsh plugin --profile web add dsh-experience-map@0.1.0-beta.3 @huggingface/transformers@4.2.0
```

Add `@huggingface/transformers@4.2.0` to the `headless` and `experience-management` Profiles too if they will run semantic recall. DSH may warn that Transformers.js is not a DSH Bundle; that is expected, and it remains an ordinary dependency of that Profile. Review the [security policy](../SECURITY.md) before opting in.

### 5.2 Download the pinned model to a durable directory

Install the `hf` CLI using the [official Hugging Face instructions](https://huggingface.co/docs/huggingface_hub/main/en/guides/cli), then download only the four runtime files:

```sh
EXPERIENCE_MODEL_DIR="${HOME}/.local/share/dsh-experience-map/models/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78"
mkdir -p "${EXPERIENCE_MODEL_DIR}"
hf download Xenova/multilingual-e5-small \
  config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx \
  --revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78 \
  --local-dir "${EXPERIENCE_MODEL_DIR}"
shasum -a 256 "${EXPERIENCE_MODEL_DIR}/onnx/model_quantized.onnx"
```

The last command must print:

```text
f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193
```

Do not use `/tmp` or `/private/tmp`; operating-system cleanup would invalidate the configured path. The files can be checked against the [pinned Hugging Face revision](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78).

### 5.3 Enable it in plugin settings and read back the state

Open `Settings → Plugins → Plugin configuration → Experience Map → Local semantic matching`:

1. Set `Local embedding provider` to `transformers_js`.
2. Set `Verified model directory` to the expanded **absolute path** of `EXPERIENCE_MODEL_DIR` above.
3. Keep every other calibrated default unchanged instead of tuning thresholds by intuition.

The key defaults must read:

| Field | Evaluated value |
| --- | --- |
| Model / revision | `Xenova/multilingual-e5-small` / `761b726dd34fb83930e26aab4e9ac3899aa1fa78` |
| Artifact / SHA-256 / bytes | `onnx/model_quantized.onnx` / `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193` / `118308185` |
| Tokenizer/config bundle SHA-256 | `4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133` |
| Dimension / dtype / pooling | `384` / `q8` / `mean` |
| Query / passage prefixes | `query: ` / `passage: ` |
| Max tokens / similarity threshold / top-two margin | `512` / `0.76` / `0.025` |
| Equivalence threshold / margin | `0.88` / `0.03` |

Settings apply live; no Host restart is required. `Configured, awaiting corpus` is expected before any saved Experience exists. After saving at least one Experience and allowing the index to build, the status must become `Semantic index ready`. If it says `Model unavailable (lexical fallback)`, do not treat subsequent results as local-E5 results: first check the Profile dependency, absolute path, revision, and digests.

Automatic dense applicability and semantic equivalence are currently enabled only for `procedure` and `diagnostic`. This is the evaluated calibration boundary, not a missing setting. Preference, Fact, Strategy, and Causal records cannot cross deterministic gates merely because E5 assigns a high score.

The pinned model directory is about 129 MB. In one macOS arm64 benchmark, its quantized artifact was 118,308,185 bytes, first load was about 739 ms, warm-query p95 was about 9.7 ms, and process RSS increased by about 576 MiB. These figures are capacity guidance, not a performance promise for every machine.

### 5.4 Which measurements used Transformers.js

- The default MiniSearch lexical baseline scored 12/12 with zero harmful matches on the frozen 12-case controlled recall replay. Those fixtures supply explicit task-family, scope, and error/tool signals; this is not arbitrary-language recall accuracy.
- The local-E5 hybrid replay used MiniSearch `7.2.0` plus the pinned model above and scored 12/12 with zero harmful matches on the same replay.
- The 108-case quality suite is not 108 pure recall queries. Deterministic logic owns extractability, kind, and evidence grounding; local E5 participates in semantic equivalence, component mapping, and applicability. The small frozen suite recorded zero false merges, zero harmful recall/context injection, and zero incorrect component evidence. It is not population-level accuracy.
- The README's 65.9% provider-token-volume reduction compares the same matched Experience with no approved Context against approved Context delivery. Local E5 was `dense_ready` during that pilot, but matching was held constant between the paired runs. The result measures reuse benefit, not E5-versus-lexical accuracy.

Recommendation: keep the lexical default for zero extra dependency and the most conservative behavior. Enable the pinned E5 setup for predominantly Chinese, paraphrased, or cross-language Procedure/Diagnostic tasks. The settings card can describe another local Transformers model identity, but automatic recall will conservatively reject or fall back because that identity is not calibrated; it does not reproduce this release's result. The current recall adapter has no external embedding provider. The external DSH-model route in settings is for Candidate enrichment, which is a separate capability path.

## 6. Terminal and headless use

Suggestion detection and recall remain enabled when the Bundle is installed into the headless profile:

```sh
dsh plugin --profile headless add dsh-experience-map@0.1.0-beta.3
dsh --profile headless "check the current tests and repair the same class of failure"
```

A terminal has no save button, so persistence, dismissal, and Plan approval remain explicit management commands. Create a dedicated profile:

```sh
dsh plugin --profile experience-management add dsh-experience-map@0.1.0-beta.3
```

Append this layer to `$DSH_HOME/profiles/experience-management/cordis.patch.yml`; do not overwrite existing user configuration:

```yaml
- insert:
    - id: experience-map-cli-startup
      name: 'dsh-experience-map/cli/startup'
    - id: experience-map-cli-runner
      name: 'dsh-experience-map/cli/runner'
```

Read canonical state:

```sh
dsh --profile experience-management experience status
dsh --profile experience-management experience suggestions-show
dsh --profile experience-management experience plan-list
```

`suggestion-save` accepts a revision-fenced JSON document rather than a fuzzy title. Copy `suggestionGroupId`, `revisionDigest`, `reviewDigest`, and `sourceDigest` from `suggestions-show`, then submit:

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

If the suggestion changed or expired, the digest fence rejects the command; read the current suggestion before deciding again. The CLI is an auditable management surface, not an unattended auto-save switch.

## 7. Verify the result

- `suggestions-show` includes the new Session and its groups.
- Save returns `saved_new_experience`, `attached_as_evidence`, or `already_recorded`; the latter two do not create a duplicate Experience.
- `plan-list` shows Match, Preflight, Plan, and approval state for the similar task.
- The actual task receives minimal Experience Context only after approval.
- Effective settings still report automatic tool execution as disabled.
- When local semantic mode is enabled, `Local semantic index` becomes `Semantic index ready` after at least one Experience is saved; otherwise the current run is still using the lexical path.

See the [main README](../README.md) for the full lifecycle, privacy model, and product boundaries.
