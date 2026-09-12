# Open-source readiness

Status: **the clean public source snapshot and `v0.1.0-beta.3` are published through both GitHub Releases and the unscoped npm package `dsh-experience-map`; the DSH community listing remains pending.** The private development Git history must never be published.

## Release boundary

The product source, tests, user documentation, public design decisions, de-identified release evidence, and community files are publishable. Historical agent handoffs, raw Session material, local profile homes, milestone tarballs, private acceptance logs, absolute user paths, and internal coordination documents are not.

The current private Git history contains a real Session log and many internal absolute-path references. Removing the current file alone would not remove it from history. Rewriting the private history is unnecessary and risks damaging evidence. The supported path is:

1. run all checks in the private source repository;
2. create a new allowlisted directory with `pnpm release:export -- /absolute/path/to/new-directory`;
3. scan that exported directory and inspect `PUBLIC_EXPORT_MANIFEST.json`;
4. initialize new Git history only in the exported directory;
5. create the public remote, push the clean history, enable private security advisories and secret scanning;
6. build the selected preview tarball once, publish those exact bytes through npm and GitHub Releases, and verify installation in fresh Web and headless Profiles.

Never attach the existing private remote or push the existing private history to the public repository.

## First public distribution

The public beta is published as the unscoped npm package `dsh-experience-map`, with the exact packed tarball also attached to its matching GitHub Release. Do not advertise `github:alcheme-labs/dsh-experience-map` as the easy install path: a git dependency fetches TypeScript source without `lib/`, and pnpm 10 requires the user to allow a package `prepare` script before it can execute. The npm package and Release tarball both ship the already verified runtime and need no installation-time build permission.

Publication follow-up status:

1. [x] add the repository topics `dsh-plugin`, `deepseek-harness`, `agent-memory`, `experience-replay`, and `local-first`;
2. [x] verify the uploaded Release tarball and npm package in fresh Web, headless, and management Profiles;
3. [ ] publish the prepared draft once in the official `Show Your Plugins!` Discussions category;
4. [ ] confirm the repository appears on the `dsh-plugin` topic page and that the Discussion link opens for a signed-out reader;
5. [x] publish one identical `0.1.0-beta.3` artifact to GitHub and npm, then verify Registry readback and supported dist-tags.

The community post must remain visibly labelled unofficial and include the project URL, a concise explanation, the DSH integration path, a representative interface screenshot, and qualified rather than promised benefit measurements.

## Gates

| Gate | Required result | Current result |
| --- | --- | --- |
| Sensitive-history audit | No direct publication of private history | Passed by clean-export boundary; direct publication prohibited |
| Public snapshot allowlist | Raw Sessions, credentials, databases, local homes, internal evidence, and absolute user paths excluded | Automated by export and release checks |
| Secret scan | No unresolved finding in the exported snapshot | Recorded in `evidence/release/security-audit.json` |
| Production dependency audit | No high-severity advisory in default installed dependencies | Transformers.js removed from automatic installation; audit result recorded |
| Optional semantic runtime | Explicit installation and risk disclosure | Optional peer; disabled by default |
| Package contents | Only built runtime, bilingual README, license, security policy, notices, and patch | Automated dry-run inspection |
| Functional verification | Typecheck, unit/integration tests, build, docs tests, package check | Recorded in `evidence/release/package-validation.json` |
| Product evidence | Exact task, treatment, measurements, raw-log privacy boundary, and non-claims | `docs/release/BENEFIT_EVIDENCE.md` |
| Community health | Contribution, conduct, support, security, changelog, CI, issue and PR templates | Present in clean snapshot |
| External publication | Public Git remote, npm Registry, and GitHub Release readback | Public repository plus matching npm and GitHub `v0.1.0-beta.3` artifacts read back; community listing pending |

## Published artifact immutability

The `v0.1.0-beta.1` tag and Release assets remain immutable. After that Release was published, the English README maintainer display was corrected from the Chinese legal entity name to `Alcheme Labs`; Chinese and legal attribution remain `杭州星原驱动科技有限公司`.

`0.1.0-beta.2` introduced the public unscoped npm identity, but fresh DSH installation found that its `preinstall` Node guard was rejected by the Profile's strict build-script policy. It remains immutable and is not the supported installation target.

`0.1.0-beta.3` removes every install lifecycle script and enforces the Node 22.19+/24+ requirement when the Host or management CLI module is actually loaded. Its tarball is built once, published unchanged to npm, and attached to the matching GitHub Release. Both channels are checked against the packed artifact before installation guidance is updated.

## Dependency decision

MiniSearch is the only required production dependency and is installed normally; its MIT notice ships in `THIRD_PARTY_NOTICES.md`. DeepSeek Harness and React remain host peers.

Transformers.js remains supported as an optional local text-embedding runtime, but it is no longer auto-installed. Its current upstream dependency graph contains native-package advisories. The default package therefore remains lexical and conservative unless an operator deliberately supplies the peer runtime and a digest-pinned local model after reviewing the advisories. This preserves the local semantic adapter without silently exposing every installation to a vulnerable native stack.

## Rollback

A defective npm version must be deprecated, a corrected version released, and installation guidance updated. Never reuse or move an immutable version tag. Schema v8 is pre-release and rejects older databases; a compatibility change needs its own migration and rollback evidence.

## Continuing non-goals

- No published tag or Release asset is moved, replaced, or reused.
- No existing private Git history is rewritten or pushed.
- Do not point supported npm installation guidance at an artifact that has not passed a fresh DSH Profile installation.
- No raw Session or model body is made public to strengthen a benchmark claim.
- No automatic Experience execution is enabled.
- No general token-saving percentage is claimed from a one-family pilot.
