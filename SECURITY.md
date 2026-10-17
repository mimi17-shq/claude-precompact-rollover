# Security

## Private data

Claude transcript files can contain conversation text, tool inputs and outputs, file paths, source code, credentials, and personal information. Do not attach a real transcript to a public issue.

Keep transcript parsing and `context-plan.json` on a trusted local machine. The project does not expose an HTTP server; an integration that adds one must provide its own authentication, authorization, origin checks, and path confinement. A context plan contains message IDs rather than text, but those IDs and the resulting manifests should still be treated as private session metadata.

When reporting a bug, reproduce it with a synthetic transcript and replace session IDs, message UUIDs, paths, account details, hostnames, and digests.

## Failure behavior

The rebuild pipeline is fail-closed. It must not mark a target ready when:

- the source is changing;
- the latest reply is incomplete;
- user/assistant pairing is ambiguous;
- a context plan targets another session or references a missing message ID;
- a configured channel scope cannot classify a message;
- source and target visible-content digests differ; or
- the Agent SDK cannot read or fork the session.

The core does not terminate or restart Claude. Supervisors that consume `next-window.json` must independently verify ownership, permissions, target session identity, model, effort, and digest status before switching processes.
