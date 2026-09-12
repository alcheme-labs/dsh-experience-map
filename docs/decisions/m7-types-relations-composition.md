# M7 typed Experience and composition decision

M7-02 extends the existing Candidate, Version, planning, Context and Browser path. It does not introduce a second memory service or a parallel planner.

The six Experience kinds share one source-bound Candidate envelope and one immutable Version envelope. Each kind selects its required component roles from `TYPE_BEHAVIORS`; kind remains immutable after a series is created. The proposal adapter may suggest any one of the six kinds, but publication still requires exact source references and field review.

`experience_relations` is the only canonical relation store. A relation binds typed object references, scope, qualifiers, valid time, evidence IDs, status and the decision that created it. `requires`, `precedes`, `specializes` and `supersedes` are acyclic. Symmetric relations use one stable record. Causal names do not raise evidence grade or grant execution permission.

Planning reads active, currently valid canonical relations for the exact selected component revisions. The existing deterministic composer uses `precedes` and `conflicts_with`; every selected relation ID is retained in the immutable plan. An authorized current-Usage Override may resolve an Experience conflict, but cannot suppress safety, permission, privacy, legal or current-task blockers.

`suggest` is a durable Usage mode. It exposes selected contributions, sources and adoption choices without creating execution authority. `guided` continues to use the existing exact Plan approval, Context delivery and ordinary Harness tool authorization paths.

Preference Policy contributions are classified as advisory, post-output validation, or pre-execution blocking from their explicit modality and authority. Model-inferred content cannot become mandatory or prohibitive. If streaming output cannot be validated before exposure, the enforcement result is `unknown`; the UI must not claim enforcement succeeded.

This design is removed or revised if a real producer cannot create source-bound non-Diagnostic Candidates, if relations do not change a real Plan/readback, or if another canonical writer appears.

## OPT-B explicit component selection (implementation pending acceptance)

LocalOwner may use the existing `relation-declare` producer and canonical `composes_with` relation to declare a task-specific optional action. The qualifier `selectionPolicy=explicit_optional_component` requires exact `anchorComponentRevisionId`, `optionalComponentRevisionId`, a nonempty `independenceReason`, and `scope.taskInputDigest` matching the planner fingerprint. Both endpoints must be distinct step/resolution_candidate components in the same current-active version. The write boundary validates these constraints; consumption rechecks exact task, revisions, applicability and validity. Ordinary relations retain their existing meaning.

Only a retained anchor can justify excluding the optional action. Required dependencies override exclusion; contradictory declarations or uncertain ordering retain components conservatively. Preconditions, checks, verification and recovery obligations remain. Selection and discard reasons and relation IDs belong in the immutable pre-approval Plan and its digest; approval and Context must consume that same selection. A new declaration cannot rewrite an old approved Plan. This is explicit owner-scoped selection, not automatic natural-language inference of independence. No new schema, DTO, Client editor or state owner is introduced.

The execution clarification and positive/negative acceptance cases are recorded in `../external-agent-pilot/parallel-b/review-01/H1-DECISION.md`. This clarification corrects an underspecified initial handoff; it is not evidence that implementation has passed.
