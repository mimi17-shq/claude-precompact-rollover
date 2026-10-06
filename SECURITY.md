# Security

## Private data

Claude transcript files can contain conversation text, tool inputs and outputs, file paths, source code, credentials, and personal information. Do not attach a real transcript to a public issue.

When reporting a bug, reproduce it with a synthetic transcript and replace session IDs, message UUIDs, paths, account details, hostnames, and digests.

## Failure behavior

The rebuild pipeline is fail-closed. It must not mark a target ready when:

- the source is changing;
- the latest reply is incomplete;
- user/assistant pairing is ambiguous;
- a configured channel scope cannot classify a message;
- source and target visible-content digests differ; or
- the Agent SDK cannot read or fork the session.

The core does not terminate or restart Claude. Supervisors that consume `next-window.json` must independently verify ownership, permissions, target session identity, model, effort, and digest status before switching processes.
