# M7 relation map and storage readiness

M7-06 renders a query-time relation map from the M7-02 `experience_relations` table. The map contains typed nodes, canonical relation identities, status, evidence references, causal grade, and an accessible text fallback. `causal_candidate` remains visibly distinct from `causally_influences`; rendering cannot promote a causal claim or authorize execution.

The projection has no stored edge copy, checkpoint, or writer. Its generation digest is derived from the canonical relation rows, so a new process rebuilds the same nodes and edges. A rendering failure cannot damage or modify canonical relations.

`InfrastructureReadinessContract` owns the evidence required before a graph database can be proposed: a measured workload across the required query classes, a defined current-store failure, canonical parity, migration safety, and rollback evidence. The readiness evaluator records only facts the current SQLite owner can observe. One interactive query is not a workload study, so the current evaluation records the sample and remains `not_ready` with all three missing signals exposed.

Neither the Browser nor a caller can submit readiness booleans. A future producer must supply real query observations, failures, and rollback evidence through a separately reviewed capability before `ready_for_review` can be reached. The current product therefore keeps SQLite as the sole canonical relation owner and does not add a graph database.
