# M7 Forget ownership and ordering

Status: accepted for EM-M7-01.

## Decision

Experience Map implements Forget as a revision-bound owner command with an impact preview. The command's SQLite transaction first marks the Experience Series retired, writes the ForgetRequest, tombstone, step results, command receipt, audit event, and projection outbox entry. A committed receipt therefore means the Series is already excluded from canonical retrieval. Session surface retirement and rebuildable projection invalidation run afterward and cannot restore recall if either fails.

The preview digest binds the current Version, Series revision, active Context deliveries, retained immutable-history classes, and Content Vault applicability. The command must echo that digest and revision. A changed or already retired Series fails closed. CommandId deduplication returns the same receipt only for the same authenticated actor and exact command payload.

## Ownership

SQLite owns Experience lifecycle, Forget progress, tombstones, receipts, audit, and projection work. The DeepSeek Harness Session Log remains the authority for immutable conversation history and the current Session surface. Experience Map reuses Session surface replacement to retire a delivered Experience Context and records the resulting ContextRetirement reference; it does not edit or delete Session events. The learning tables remain rebuildable projections and never decide whether an Experience can be recalled.

No governed-content producer or consumer is active, so Content Vault cleanup is `not_applicable`. Forget does not claim physical deletion from Session history, provider retention, backups, exports, or other external copies.

## Failure and recovery

A Context or projection failure leaves canonical recall stopped and makes the ForgetRequest `partial` or `unknown` with per-step reason codes. Restart reads the retired Series before any cleanup retry, so an interrupted operation cannot make the Experience eligible again. An offline Session is reported as deferred or unknown rather than as replaced. Immutable Versions, receipts, audit events, and source references are retained for provenance.

## Product readback

The embedded management workspace previews the exact impact, requires an explicit reason and confirmation, commits once, then reads the ForgetRequest from the Host. It displays recall, Context, projection, Vault, and tombstone step outcomes. The management CLI exposes the same preview, command, and request readback; headless operation requires no Browser service.
