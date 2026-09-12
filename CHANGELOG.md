# Changelog

All notable changes will be documented here. The project follows semantic versioning after its first published release.

## Unreleased

## 0.1.0-beta.3 - 2026-09-12

- Removed the install lifecycle script that strict DSH pnpm profiles reject, so registry installation works without `pnpm approve-builds`.
- Moved the unsupported Node 23 guard to the Host and management CLI runtime entrypoints.
- Pointed the supported npm and GitHub installation guidance at the verified `0.1.0-beta.3` artifact.

## 0.1.0-beta.2 - 2026-09-12

- Published the community plugin under the unscoped npm name `dsh-experience-map`.
- npm initially bound `beta` and `latest` to this version, but a fresh DSH install exposed that its `preinstall` guard was rejected by the Profile's strict build-script policy.
- Use `Alcheme Labs` as the public English maintainer name while retaining `杭州星原驱动科技有限公司` in Chinese and legal attribution.
- Kept the published `v0.1.0-beta.1` tag and assets immutable; `beta.2` carries the corrected attribution and npm package identity.

## 0.1.0-beta.1 - 2026-09-12

- Added automatic local Session suggestion detection, recent-Session grouping, cross-Session occurrence consolidation, and an explicit save gate.
- Added six typed Experience forms with reviewed Candidates, immutable Versions, conservative recall, current Preflight, Plan approval, one-time Context delivery, verification, Settlement, Revision, and Forget.
- Added Chinese and English interfaces, Browser-free Host operation, and an opt-in management CLI.
- Added local-first semantic formation and recall with abstention, component correspondence checks, and duplicate evidence attachment to one canonical Experience.
- Added clean public-export, dependency, package-content, privacy, and release-evidence gates.

This preview has not been published to npm. Its first distribution is a prebuilt GitHub Release tarball.
