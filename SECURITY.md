# Security policy

## Supported code

Security fixes are made on the latest pre-release branch. The npm package is still a beta, so there is no supported stable release line.

## Report a vulnerability

Do not open a public issue with credentials, private Session content, exploit details, or user data. After the public repository exists, use its private GitHub Security Advisory form. Until then, contact the maintainer through a previously established private channel and include only the minimum reproduction material.

We aim to acknowledge a complete report within seven days. Acknowledgement is not a promise that a report is valid or that a fix will be released on a particular date.

## Security boundaries

- DeepSeek Harness owns model credentials, Session history, tools, jobs, approvals, and authenticated transport.
- Experience Map stores Experience-domain state in its local SQLite database. Browser state is not authoritative.
- Automatic suggestion detection and default recall are local. Candidate model generation requires an explicit disclosure confirmation.
- Experience Context is delivered only after approval of the current exact Plan. Tool execution is disabled and cannot be enabled by an Experience setting.
- Raw Session logs, profile credentials, user identifiers, local databases, and absolute user paths must never be attached to an issue or committed to the public repository.

## Optional local embedding runtime

`@huggingface/transformers` is an optional peer runtime, not an automatically installed dependency. At the time of this pre-release it carries upstream native dependency advisories. Do not install it merely to enable a feature by default. If you deliberately enable it, use only the pinned, digest-verified local text model described by the settings, do not process untrusted archives or images, and review the current upstream advisories first. Lexical retrieval and the conservative hard gates remain available without it.

## Public-history rule

The private development repository contains historical acceptance material that is not suitable for publication. Never make that Git history public. Create releases from the allowlisted clean snapshot produced by `pnpm release:export -- /path/to/new-directory`, scan the exported directory, and initialize new public history there.
