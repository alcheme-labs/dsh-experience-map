# M7 audit query ownership

M7-04 reads one owner-authorized Experience or Usage dossier from the canonical Experience SQLite records and append-only domain audit events. It does not copy this timeline into Harness Chat events and does not make the Browser cache authoritative.

The query starts from one exact `experience` or `usage` identity and follows only stored domain identities. The dossier includes connected Candidate, Version, relation, Plan, Context, execution, Settlement, Revision, Forget, Markdown, governance, readiness, and evaluation records when those records exist. External Session or historical bodies remain with their source systems; the dossier reports their locator and digest as `metadata_only` instead of copying or inventing content.

Pagination is stable over descending `(recordedAt, auditId)` order. A cursor is bound to the queried subject and `asOfRecordedAt`, so it cannot be reused for another dossier. Owner authorization is checked before traversal. The query rejects an unknown subject, a malformed cursor, a cursor from another query, and cross-actor access.

Append-only audit events support exact historical reconstruction. Mutable current-state records do not claim an intermediate snapshot that was never stored: an `asOfRecordedAt` query reports such an object as `metadata_only` with `historical_snapshot_not_recorded`. This limitation is explicit evidence availability, not a present-state value presented as history.

The authenticated Experience inspector and the base-only management CLI consume the same Host query. A fresh process reconstructs the same connected object identities and audit sequence from SQLite.
