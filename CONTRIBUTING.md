# Contributing

Thank you for helping improve Experience Map.

## Development environment

- Node.js `^22.19.0` or `>=24.0.0`; Node 23 is intentionally rejected.
- pnpm through Corepack.
- DeepSeek Harness `0.1.5-rc.2` for installed integration work.

```sh
corepack pnpm install
corepack pnpm run check
corepack pnpm run test:docs
```

Use a separate Harness profile for installed testing. A plugin change must not modify DeepSeek Harness product source.

## Change discipline

Keep one canonical Experience store and one Host-owned command/query path. Reuse existing domain and persistence owners instead of adding parallel state. Changes to persistence, permissions, Session binding, recall, Plan approval, or Context delivery need negative, idempotency, restart/readback, and affected integration coverage.

For retrieval changes, measure false matches separately from missed matches. A higher recall score is not acceptable when it injects a wrong Experience. New model calls must have an explicit producer, user-visible disclosure, budget, failure behavior, and deterministic validation boundary.

## Privacy in tests and issues

Use synthetic or de-identified fixtures. Do not commit raw Session logs, credentials, `.dsh` profile homes, local databases, user identifiers, private model responses, or absolute user paths. Replace opaque production IDs with stable test IDs.

## Pull requests

A pull request should describe the observable behavior, the current owner it reuses, the risk level, tests run, and any remaining product boundary. Keep generated bundles, local model artifacts, screenshots with private content, and packed tarballs out of ordinary changes.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
