# M6 learning projection ownership

Status: accepted for the M0–M6 Diagnostic vertical.

## Decision

Experience Map owns one rebuildable learning projection over its canonical SQLite records. Canonical Candidate, field-decision, Plan, Usage, Settlement, and Revision transactions enqueue reconciliation through the existing Experience outbox. One Cordis-owned worker leases those entries and rebuilds extraction, applicability, revision, and execution predictions, authority decisions, and non-unknown outcomes in a single local transaction.

The projection does not consume Harness Session projection checkpoints or Session telemetry. Session projection owns current per-Session state, while Session telemetry owns deployment-selected redacted export. Neither provides the canonical Experience decisions, pairings, or outcomes required by learning records.

Each prediction id is a deterministic digest of its capability and immutable source identities. Each label id is a deterministic digest of the prediction id and the exact decision or outcome identity. A row includes the predictor or rule version, scope, source references, prediction payload, separately stored human labels, and separately stored observed outcomes. Plan labels resolve the actor from the exact GovernanceDecision, withdrawal receipt, or adaptation audit instead of attributing the decision to the request initiator. Pending and expired requests create no human label; supersession creates an `adapted` label only when an exact user adaptation audit exists. Applicability labels attach only to versions that contributed to the decided plan. An unknown, missing, or unpairable result creates no outcome label.

The worker replaces only the four supported projection capabilities. It cannot modify a Candidate, Experience, Version, Plan, Usage, Verification, Settlement, Revision, Receipt, Audit, Session record, automation state, or Unlock evaluation. Projection loss therefore does not alter domain truth and a later reconcile recreates the same ids. The checkpoint records the highest processed outbox row, rebuild generation, and builder version; it is diagnostic progress, not a second domain watermark.

## Current consumers

The authenticated Experience tab shows generation, source offset, builder version, capability counts, prediction ids, and label counts in its existing technical inspector. The base-only management CLI returns the same projection through `experience learning-show`. M7 evaluation may consume this read model, but it must not treat its presence as an Unlock decision.

## Failure and recovery

Projection work is bounded by configurable poll, lease, retry, and batch values. Each claimed row carries its exact lease-expiry token; commit and release compare that token so an expired worker cannot modify a row reclaimed by another Host process. A failed transaction releases the current claim for a later retry. An expired claim returns to pending. Duplicate reconciliation produces the same row ids. Host startup compares the stored builder version with the current deterministic implementation and queues one rebuild when they differ, then drains due work before publishing the Experience service. An explicit learning query drains currently due work before readback. Failure never rolls back a previously committed canonical Experience transaction.

## Deferred capabilities

Merge and causal-promotion rows remain absent because the first Diagnostic vertical has no real merge or causal-review decision. Unlock evaluation, automatic promotion or demotion, controlled three-arm evaluation, Markdown projection, relation-map projection, and Forget belong to their M7 capability verticals. M6 does not create placeholders for them.
