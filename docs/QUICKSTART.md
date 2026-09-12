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

## 5. Terminal and headless use

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

## 6. Verify the result

- `suggestions-show` includes the new Session and its groups.
- Save returns `saved_new_experience`, `attached_as_evidence`, or `already_recorded`; the latter two do not create a duplicate Experience.
- `plan-list` shows Match, Preflight, Plan, and approval state for the similar task.
- The actual task receives minimal Experience Context only after approval.
- Effective settings still report automatic tool execution as disabled.

See the [main README](../README.md) for the full lifecycle, privacy model, and product boundaries.
