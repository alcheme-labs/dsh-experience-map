# M7 Markdown projection ownership

M7-05 exports one immutable Experience Version to a bounded human-readable projection. The Experience repository owns the export receipt, Version digest, projection format, projection digest, and structured import result. Harness filesystem capability owns path resolution and file I/O for the management CLI.

Markdown is not a canonical Experience writer. An import must name an exact projection receipt and reproduce its immutable header and metadata. The parser accepts changes only to known component bodies in their original order. It rejects a changed base Version, altered or missing receipt, mismatched digest, unknown section, reordered or missing component, secret-reference-only content, oversized input, and a Version whose Series was forgotten.

A valid edit creates a normal `RevisionProposal` containing the structured component differences. The existing per-change review and publication flow remains the only path to a new immutable Version. Import never changes the base Version, publishes content, changes authority, or bypasses review.

The embedded Experience tab keeps the editor and structured review in the existing management workbench. The management CLI exports and imports through `ctx.fs`; it does not use Node filesystem calls or create a second persistence owner.
