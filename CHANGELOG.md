# Changelog

All notable changes will be documented here. The project follows semantic versioning after its first published release.

## Unreleased

## 0.1.0-beta.6 - 2026-10-02

- Distribution follow-up (2026-10-03): promote the existing beta.6 package to npm `latest`; `beta` also points to beta.6. No package rebuild or republish. DSH `0.1.5-rc.2` users must pin beta.3.

- Keep management section labels and counts on one line without changing candidate card layout, existing section switching, or narrow-container horizontal overflow.
- Align bilingual installation and quickstart documentation with beta.6; clarify recent-eight ordering, notification-only learning, DSH compatibility and preserved saved Experiences.

### beta.4–beta.6 升级说明

| 版本 | 修改或取消的原有逻辑 | 保留与使用影响 |
| --- | --- | --- |
| beta.4 | 从 DSH 0.1.5 适配到 0.2.0-rc.2；设置写入改用官方 volatile Config 字段，Host、Browser、管理 CLI 及 peer 依赖同步适配。 | 已发布 beta.3 不修改；仍用 DSH 0.1.5-rc.2 的用户继续安装 beta.3。 |
| beta.5 | 取消启动、定时和完成通知触发的自动全库发现/历史回扫；不再为了筛选最近 8 个而逐个读取所有会话。改为完成通知提供确切 Session ID 和任务结束序号，只提取这些任务。 | “最近 8 个”从已观察到的会话记录排序；旧格式会话重新使用时可学习新任务，未观察到的旧任务及停用期间任务不补提取。DSH 可能仍返回指定单个会话的完整快照，未修改其内部读取实现。 |
| beta.6 | 管理分类按钮不再将数量排到文字下一行，改为同一行；统一本次发布的文档版本和逻辑说明。 | 候选卡片、分类切换、保存、经验匹配与召回逻辑不变。 |

beta.5 **保留了定时维护**：它处理已观察任务的重试、建议过期和已保存经验的召回索引维护，不用于发现历史会话。原有已保存经验、显式保存和权限校验、跨会话分组、默认最近 8 个与 14 天建议 TTL 均保留。任务结束通知不被当作成功证明；仍须通过原有证据校验。

升级采用 sidecar v4/v5/v6 → v7 的增量迁移，保留已有表、建议结果和处理记录；权威经验库仍为 schema v8，不迁移或删除 DSH 聊天历史。停用插件或关闭自动建议期间完成的任务不会自动补学。回退前应停止插件并使用升级前备份的 sidecar，不能用旧备份覆盖后来保存的权威经验。


## 0.1.0-beta.5 - 2026-10-02

- Stop automatic startup and periodic Session-history discovery. Only real `turn/end` notifications enqueue learning; tasks completed while the plugin is inactive are not retrospectively learned.
- Require explicit Session IDs at the read boundary and extract only notified complete task cuts. Reused old Sessions contribute new tasks without backfilling prior work; recent-N/14-day TTL applies to the already observed Session index.
- Persist observed task-end sequences and request versions in the existing SQLite sidecar. Concurrent notifications, retry, shutdown and restart retain their exact task scope; analysis and acknowledgement commit/roll back atomically.
- Preserve saved Experience Versions, explicit save/permission gates, cross-Session grouping and saved-Version retrieval. Return canonical save receipts independently of ongoing task reads.
- Additively migrate disposable sidecar v4/v5/v6 to v7, preserve existing tables/results, and stop obsolete history scheduling. No DSH modification or chat-data migration.
- Keep escaped sensitive evidence blocked, expire cached suggestion text, refresh semantic decisions after settings/retrieval changes, and cancel in-flight work on shutdown.

## 0.1.0-beta.4 - 2026-09-30

- Adapted the Host, Browser, and optional management CLI to official DSH `0.2.0-rc.2` without changing the published `beta.3` artifact for DSH `0.1.5-rc.2`.
- Moved editable settings to DSH 0.2's volatile Config fields and verified an installed Web Profile's settings write, Host readback, and restore.
- Aligned Cordis and Schemastery peers with the official DSH 0.2 runtime. Published the verified tarball to npm with the `beta` tag; `latest` was retained on `0.1.0-beta.3` at that publication; the 2026-10-03 distribution follow-up promotes beta.6 to `latest`. No GitHub Release was created in this npm publication task.

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

The first beta was distributed as a GitHub Release tarball. Since beta.2 the plugin is also distributed through the unscoped npm package `dsh-experience-map`; current prereleases use the `beta` tag. Historical versions remain immutable.
