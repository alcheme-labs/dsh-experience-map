# M7 learning governance ownership

M7-03 reuses the canonical Experience SQLite owner, the existing outbox-driven learning projector, `ActorResolver`, authenticated Connection RPC, and the existing Experience inspector. It does not use Session telemetry as a second learning truth and does not add another worker, database, page, or authorization system.

The six producers are real domain records: Candidate review for extraction, Preflight and Plan decisions for applicability, RevisionProposal review for revision, selected `composes_with` relations for merge, reviewed `causal_candidate` retention or evidence-qualified promotion for causal promotion, and approved Usage plus Settlement for execution. A retained causal candidate is a real negative promotion label, not a promoted relation. Missing labels remain absent and reduce coverage. An explicitly recorded `unknown` outcome remains present with its own rate, does not satisfy outcome sample coverage, and never counts as a correct sample.

`UnlockContract`, immutable evaluation, and the current per-capability level are owned by the Experience repository. The first product phase exposes only `shadow` to `suggest`, plus immediate demotion to `shadow` or `disabled`. A passed current-sample evaluation and a new local-owner governance decision are both required for promotion. No evaluation changes a capability level by itself.

Removing the learning governance path would make the M7 learning tests, authenticated RPC readback, and Experience inspector evaluation fail. Later automation levels remain protocol vocabulary only and are not accepted by the public M7 command parser.
