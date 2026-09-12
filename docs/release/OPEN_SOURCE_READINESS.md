# Open-source readiness

Status: **the clean public source snapshot and `v0.1.0-beta.1` GitHub Pre-release are published; npm and the DSH community listing remain pending.** The private development Git history must never be published.

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

Publication follow-up status:

1. [x] add the repository topics `dsh-plugin`, `deepseek-harness`, `agent-memory`, `experience-replay`, and `local-first`;
2. [ ] verify the uploaded Release tarball from its immutable URL in fresh Web and headless Profiles;
3. [ ] publish the prepared draft once in the official `Show Your Plugins!` Discussions category;
4. [ ] confirm the repository appears on the `dsh-plugin` topic page and that the Discussion link opens for a signed-out reader;
5. [ ] publish the next identical artifact to GitHub and npm only after npm write authority and Registry readback succeed.

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
| External publication | Public Git remote and GitHub Release readback | Public repository and `v0.1.0-beta.1` Pre-release with tarball plus checksum read back; npm/community pending |

## Published artifact immutability

The `v0.1.0-beta.1` tag and Release assets are immutable and must not be moved or replaced. After that Release was published, the English README maintainer display was corrected from the Chinese legal entity name to `Alcheme Labs`; Chinese and legal attribution remain `杭州星原驱动科技有限公司`.

Because the corrected README is part of the npm tarball, the next npm publication must use `0.1.0-beta.2`. Build that tarball once, attach the exact bytes to the matching GitHub Release, publish those same bytes to npm under the `beta` dist-tag, and verify both integrity values before updating installation guidance. Do not publish a different npm payload as `0.1.0-beta.1`.

## Dependency decision

MiniSearch is the only required production dependency and is installed normally; its MIT notice ships in `THIRD_PARTY_NOTICES.md`. DeepSeek Harness and React remain host peers.

Transformers.js remains supported as an optional local text-embedding runtime, but it is no longer auto-installed. Its current upstream dependency graph contains native-package advisories. The default package therefore remains lexical and conservative unless an operator deliberately supplies the peer runtime and a digest-pinned local model after reviewing the advisories. This preserves the local semantic adapter without silently exposing every installation to a vulnerable native stack.

## Rollback

Before npm publication, rollback is simply to discard the generated public directory; the private source repository is unchanged. After publication, a defective version must be deprecated, a corrected version released, and installation guidance updated. Never reuse or move an immutable version tag. Schema v8 is pre-release and rejects older databases; a compatibility change needs its own migration and rollback evidence.

## Continuing non-goals

- No published tag or Release asset is moved, replaced, or reused.
- No existing private Git history is rewritten or pushed.
- No npm publication receives the `latest` dist-tag during the beta.
- No raw Session or model body is made public to strengthen a benchmark claim.
- No automatic Experience execution is enabled.
- No general token-saving percentage is claimed from a one-family pilot.
