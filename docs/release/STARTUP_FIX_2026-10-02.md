# Notification-driven Experience repair — 2026-10-02

## Confirmed product scope

The user chose notification-only learning. No automatic startup/periodic historical discovery, including current-format historical Sessions. Learn only completed tasks observed while the plugin is running. Reused old Sessions contribute new tasks; tasks completed while inactive are not backfilled. Previously saved canonical Experiences remain usable. Recent eight means the most recently active Sessions already admitted by observed notifications, not a claim of complete historical corpus coverage.

## Capability and implementation

Live path: real DSH `turn/end` -> one existing worker -> durable notification task-end sequences/request version in existing projection SQLite -> public observation of the explicit Session -> only notified completed cuts -> existing detector and grouping -> analysis + exact acknowledgement + published generation in one transaction -> Experience workbench -> explicit owner save -> canonical receipt -> saved-Version retrieval. Existing Experience repository remains the only canonical owner. DSH is read-only/out of modification scope.

Medium risk: durable concurrency/privacy/cross-layer state. Notifications received during reads must stay pending; failed/cancelled reads cannot acknowledge unseen work; sidecar generation/progress roll back together. Completion is not proof of task success. Sensitive evidence, permissions, explicit save and idempotency gates remain unchanged. TTL removes expired cached suggestion text. No raw chat copies, private-format parsing, new service, writer or automatic save.

Additive sidecar migration v4/v5/v6 -> v7 retains historical compatibility tables and existing suggestion/disposition/retrieval data; adds exact observed task ends and stops obsolete background scheduling. Original canonical schema remains v8. Rollback: stop worker, use prior package and backed-up sidecar; never roll canonical data back over newer writes. The earlier full-history completion gate is superseded by the user's explicit scope choice, not claimed passed. Its prior evidence is retained locally in `/private/tmp/experience-history-repair-superseded.md`.

## Acceptance and cadence

Focused regressions: zero catalogue/body reads on startup and repeated idle polls; notification-only new/reused Session cuts; recent-eight ranking over observed records; concurrent/repeated notifications; bounded failures/retry; interruption/restart; atomic generation/progress rollback; additive v4/v5/v6 migration; sensitive evidence; TTL; independent durable save and saved retrieval. Run affected-stack tests during development, full checks and packed smoke at release close. Runtime gate uses an unfiltered copy of the real mixed-format corpus: no startup/idle history reads; public Session task produces a suggestion; canonical save/receipt and retrieval readback; restart retains saved records with zero automatic chat reads; clean shutdown and SQLite integrity. Native DSH window and Experience Host readback must pass before publication.

Proof saturation: after these boundaries and real consumer/readback pass, publish the same frozen tarball on npm `beta`; do not extend to DSH or GitHub. Non-goals: retrospective learning, current-format history sweeps, format classification, provider patches, latest-tag changes or public/private-history export. Complexity tripwires: any history discovery fallback, second worker/writer or speculative cache requires removal before acceptance.

## Verified release evidence

Owner: existing ExperienceProjectionWorker and ExperienceProjectionStore; canonical ExperienceRepository is unchanged. The notification-only capability is complete locally, including native consumer readback. The obsolete historical discovery/backfill obligation is removed by the confirmed scope decision; no historical learning completion is claimed. DSH source and original chat history were not modified.

| Acceptance boundary | Evidence | Result |
| --- | --- | --- |
| Zero startup/idle history reads, observed exact cuts, notification concurrency/replay, retry/cancellation/restart, transaction rollback, additive migration, privacy and TTL | `tests/incremental-suggestion.spec.ts` and affected automatic/lifecycle/retrieval/settings/client tests; `/private/tmp/experience-notification-full-check.log` | 76 files, 587 tests pass; Host/Client/test typecheck and build/declarations pass |
| Published installation guidance and workbench scope | `/private/tmp/experience-notification-docs-final.log` | 2 files, 14 tests pass |
| Frozen package entrypoints and private-data boundary | `/private/tmp/experience-notification-final-smoke.json`, `/private/tmp/experience-notification-public-release-check.log` | Host/CLI imports pass; 167 package files, no source/tests/private history/model payload; optional-model policy unchanged |
| Real DSH public notification -> suggestion -> explicit owner save -> exact receipt -> saved retrieval | `/private/tmp/experience-incremental-runtime-acceptance.log`, isolated root `/private/tmp/experience-notification-runtime-q8gSUG` | Actual DSH 0.2.0-rc.2 Electron Node 24.18.1 with an unfiltered private copy of 3,614 real mixed-format Sessions; public completed-task fixture produces one suggestion in 79 ms, saves in 25 ms, exact receipt and one saved retrieval document read back. The event fixture is controlled; no Agent/model call is claimed |
| Unobserved old cuts excluded; idle/restart do not discover chat history | Same log, first run and fresh process restart | Startup list/observe/body reads 0/0/0; one notified Session read only; 100 s idle adds zero reads. Restart keeps saved version/retrieval, reads 0/0/0, another 100 s adds zero reads. Both DB quick checks pass, pending/failed jobs 0, shutdown 104/68 ms |
| Native installation and real consumer | `/private/tmp/experience-notification-install.log`, `/private/tmp/experience-notification-native-readback.json`, CUA native UI observation | Official offline plugin manager installs beta.5 enabled; all 158 runtime files match final tarball; original DSH window loads and Experience Host state reads back; UI states notification-only/no history sweep. Sidecar migrates 6 -> 7, canonical remains 8; both quick checks pass and canonical counts unchanged. One idle CPU sample: desktop 0%, Host 0.6%; this is a sample, not a sustained bound |

Artifact: `dsh-experience-map-0.1.0-beta.5.tgz`, 1,216,494 bytes; SHA-256 `7ca3d1b9059c18920e659c96277bb3b06d7433212acf0b0ab20a1c0d4bb3099a`. Final package differs from the longer runtime-tested candidate only in the two README files; every code/manifest/runtime entry is identical. Installed files were independently compared to the final package.

Native rollback backup: `<DSH_HOME>/repair-backups/experience-map-notification-2026-10-02`, with profile manifests, previous plugin tarball and consistent SQLite backups. Restore only with the app stopped; preserve any later canonical writes. Original histories are untouched. Earlier auto-review rejected a destructive drop-table proposal; the accepted implementation uses additive migration and retains compatibility tables/data and safety coverage.

npm public readback passed: version `0.1.0-beta.5`, `beta` -> `0.1.0-beta.5`, `latest` -> `0.1.0-beta.3`. Downloaded public tarball is exactly 1,216,494 bytes and matches the frozen/installed SHA-256 above, npm SHA-1 `b9dc69573720e388dfab48e05c7bfc0698d8a64e`, and declared SHA-512 integrity. Evidence: `/private/tmp/experience-notification-registry-readback.json`; downloaded file `/private/tmp/experience-notification-npm-public.tgz`. Temporary npm auth configuration was removed. No GitHub action was performed.

Status: notification-only repair released and installed; no required live-path edge remains. Runtime limitations: DSH may provide a full snapshot of the one named Session; its own legacy-read implementation is unchanged. Tasks completed while the plugin is inactive are not discovered retrospectively. This release does not promise historical backfill or physically incremental source reads.


## Management navigation follow-up (beta.6)

Standard-risk presentation fix: the four management classification buttons use one scoped flex row for label and count, with nowrap labels and nonshrinking tabular counts. Existing candidate cards keep their grid layout; the existing horizontal overflow behavior at narrow container widths remains. No command, query, authority, persistence or permission changes are introduced by this layout fix.

Focused client checks: 8 files / 35 tests pass. Full plugin check: 76 files / 587 tests, Host/Client/test typecheck and build/declarations pass. Documentation checks: 2 files / 14 tests pass. Packed Host/CLI entrypoint smoke passes (167 packaged files). Logs are consolidated under `/private/tmp/experience-nav-*`.

The locally installed beta.6 artifact has SHA-256 `222d2917e28fc6f3f9c2bbcc05b9093aa4d3a17a3d0a4352083f755e06603d4b` and 1,216,693 bytes. Official desktop installation preserves canonical schema v8 and sidecar v7, with both integrity checks passing. Native wide-window management observation showed inline labels/counts; subsequent accessibility interactions confirmed mode switching and classification changes. Saved task/management baselines were reviewed.

Earlier verification limitation (superseded by the Playwright acceptance below): final narrow-window visual comparison and the complete Harness Web profile interaction gate could not be completed with the current UI automation service. It returned stale screenshots, `noWindowsAvailable` and browser-extension timeouts; native Chrome also reported concurrent user changes. The isolated official Web profile itself started successfully through its normal authenticated vendor entrypoint. These are not recorded as passed browser acceptance. Next exact action: interact with the installed Web Experience management consumer, switch all four classifications at a narrow viewport, and read back label/count placement plus unchanged task shell. At that checkpoint no beta.6 publication had been performed; published beta.5 remains immutable.

Main integration preserves the previously uncommitted startup/privacy fixes as a dedicated checkpoint. The merge resolution has exactly the same source tree as the fully checked candidate; only this acceptance note is added afterwards.


## Final beta.6 release gate — 2026-10-02

The user explicitly authorized Playwright after the native automation limitation. The final packed plugin was installed in an isolated official DSH 0.2.0-rc.2 Web profile and opened through the vendor's authenticated entrypoint. Test data consisted only of a controlled local Session attached through the public workspace registry; no real chat history or model was accessed, and no DSH source was modified. Long-lived Web connections are expected; acceptance waits for actual rendered controls rather than assuming network idle.

At the saved-baseline viewport (1487 × 1058) and a narrow viewport (1000 × 800), the real Experience consumer rendered one shell. All four management classification buttons were clicked at the narrow viewport and their corresponding lists or candidate form read back. Label/count bounding boxes stayed on the same row, with no count wrapping; the existing horizontal scrolling behavior was retained. Task/management switching and keyboard activation also passed. Wide management and task screenshots were compared against the saved design baselines; this is a visual and behavioral comparison, not pixel identity to the older mockups. Evidence: `/private/tmp/experience-beta6-browser-readback.json` and `/private/tmp/experience-beta6-ui-*.png`. The earlier missing browser gate is now closed.

Full release check passes: 76 files / 587 plugin tests, Host/Client/test typechecks, build/declarations, 2 files / 14 documentation tests, and the public/package allowlist check. The default production dependency audit finds no known vulnerabilities. Packed Host/CLI smoke passes with 167 files and no private histories, databases, test/source code or model payloads. This layout release preserves the notification-only runtime behavior already verified above; no broader historical-learning claim is made.

Frozen final artifact: `dsh-experience-map-0.1.0-beta.6.tgz`, 1,218,098 bytes; SHA-256 `50d22d4cb5d9d00f80ae255de8c13fe14686aa14bf4ed4ab4c033e14b73c7b06`. Runtime entries are unchanged from the native-tested local beta.6 candidate; bilingual README/CHANGELOG changes explain beta.4–beta.6 and are included in these final bytes. Previous artifacts remain immutable. Publication/readback remains pending until it is recorded below.
