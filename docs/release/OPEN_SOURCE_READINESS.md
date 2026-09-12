# Open-source readiness

Status: **ready to create a clean public source snapshot; the private development Git history must not be published.** The intended public remote is `https://github.com/alcheme-labs/dsh-experience-map`, but it and the first release have not been created.

## Release boundary

The product source, tests, user documentation, public design decisions, de-identified release evidence, and community files are publishable. Historical agent handoffs, raw Session material, local profile homes, milestone tarballs, private acceptance logs, absolute user paths, and internal coordination documents are not.

The current private Git history contains a real Session log and many internal absolute-path references. Removing the current file alone would not remove it from history. Rewriting the private history is unnecessary and risks damaging evidence. The supported path is:

1. run all checks in the private source repository;
2. create a new allowlisted directory with `pnpm release:export -- /absolute/path/to/new-directory`;
3. scan that exported directory and inspect `PUBLIC_EXPORT_MANIFEST.json`;
4. initialize new Git history only in the exported directory;
5. create the public remote, push the clean history, enable private security advisories and secret scanning;
6. build the selected `0.1.0-beta.1` preview tarball, attach it to the GitHub Release, and verify Release-asset installation in fresh Web and headless Profiles.

Never attach the existing private remote or push the existing private history to the public repository.

## First public distribution

The first community release uses a prebuilt `pnpm pack` tarball attached to a GitHub Release. Do not advertise `github:alcheme-labs/dsh-experience-map` as the easy install path: a git dependency fetches TypeScript source without `lib/`, and pnpm 10 requires the user to allow a package `prepare` script before it can execute. A release tarball ships the already verified runtime and needs no installation-time build permission. npm publication can later provide the shortest stable install command after registry readback succeeds.

After the clean repository and Release exist:

1. add the repository topics `dsh-plugin`, `deepseek-harness`, `agent-memory`, `experience-replay`, and `local-first`;
2. verify the Release tarball in a fresh Web and headless Profile;
3. verify that the immutable Release asset URL already present in `docs/release/COMMUNITY_POST.zh.md` downloads the validated tarball;
4. publish that draft once in the official `Show Your Plugins!` Discussions category;
5. confirm the repository appears on the `dsh-plugin` topic page and that the Discussion link opens for a signed-out reader.

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
| External publication | Public Git remote and GitHub Release readback | Pending GitHub authentication, push, Release asset, and public readback |

## Dependency decision

MiniSearch is the only required production dependency and is installed normally; its MIT notice ships in `THIRD_PARTY_NOTICES.md`. DeepSeek Harness and React remain host peers.

Transformers.js remains supported as an optional local text-embedding runtime, but it is no longer auto-installed. Its current upstream dependency graph contains native-package advisories. The default package therefore remains lexical and conservative unless an operator deliberately supplies the peer runtime and a digest-pinned local model after reviewing the advisories. This preserves the local semantic adapter without silently exposing every installation to a vulnerable native stack.

## Rollback

Before npm publication, rollback is simply to discard the generated public directory; the private source repository is unchanged. After publication, a defective version must be deprecated, a corrected version released, and installation guidance updated. Never reuse or move an immutable version tag. Schema v8 is pre-release and rejects older databases; a compatibility change needs its own migration and rollback evidence.

## Non-goals for this preparation

- No GitHub repository, tag, release, or npm version is created automatically.
- No existing Git history is rewritten.
- No raw Session or model body is made public to strengthen a benchmark claim.
- No automatic Experience execution is enabled.
- No general token-saving percentage is claimed from a one-family pilot.
