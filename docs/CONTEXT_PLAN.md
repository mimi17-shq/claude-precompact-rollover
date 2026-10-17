# Context plan v1

`context-plan.json` is the stable handoff contract for a local frontend, desktop app, chat bridge, or supervisor. It describes what the next window should inherit without putting any conversation text in the plan itself.

Machine-readable schema: [`schemas/context-plan.schema.json`](../schemas/context-plan.schema.json).

```json
{
  "version": 1,
  "sourceSessionId": "source-session-id",
  "retainTokens": 12000,
  "pinnedMessageIds": ["message-uuid"],
  "hiddenMessageIds": ["another-message-uuid"],
  "nextWindow": {
    "model": "next-model-id",
    "effort": "high"
  }
}
```

## Selection rules

1. Keep the latest complete user/assistant turns up to the approximate `retainTokens` budget.
2. Always keep at least the latest complete turn.
3. A pinned message keeps that exact original message even when it is older than the recent-token window. It does not automatically keep the other side of the turn.
4. When only one side of an older turn is pinned, its unselected partner becomes a structural placeholder so the session graph remains valid. If the turn is also selected by the recent-token window, both sides remain normally eligible.
5. A hidden message is replaced by the same kind of structural placeholder; its text is not inherited. Hide wins when the same message is both pinned and hidden.
6. Tool output, thinking blocks, compact summaries, and inherited usage counters are not part of the assembled visible context.

Chat bridges may represent several user-visible assistant replies as delivery tool calls inside one Claude turn. Configure their comma-separated tool names in `ROLLOVER_DELIVERY_TOOLS`; preview and rebuild will then expose each delivered reply UUID as an independent message ID. Selected reply texts are merged into one structurally valid target assistant node, and `pinnedMessageTargets` maps each selected source UUID to that node.

The plan is bound to `sourceSessionId`. Unknown message IDs, malformed JSON, duplicate IDs, and a mismatched session fail closed instead of silently producing a different context.

Explicit CLI flags override plan values; plan values override the general rollover config. This lets a UI prepare defaults while still allowing an operator to make a one-time local choice.

## Preview before rebuilding

```bash
bun src/cli.mjs preview \
  --session <session-id> \
  --transcript ~/.claude/projects/<project>/<session-id>.jsonl \
  --plan examples/context-plan.json
```

The preview returns JSON metadata only: selected turn IDs, counts, conflicts, and an estimated retained-token total. It does not print conversation text. Version 1 preview targets ordinary typed Claude Code sessions; channel adapters can use the same plan contract but must keep their source-classification rules on the trusted integration side.

## Rebuild from the plan

```bash
bun src/cli.mjs rebuild \
  --session <session-id> \
  --cwd /path/to/project \
  --plan /path/to/context-plan.json
```

On success the runtime directory contains:

- `next-window.json`: launch settings and verified target session ID.
- `context-manifest.json`: selection totals, source/target digests, and source-to-target mappings for pinned message IDs.
- `candidate-manifest.json`: lower-level rebuild diagnostics.

An integration can update its UI pins using `pinnedMessageTargets` after switching windows. The core still does not stop or restart Claude.

## Library use

The pure planning helpers are exported as `claude-precompact-rollover/context-plan` for Bun or Node-side adapters. Keep transcript access on the trusted local side; do not expose raw Claude transcripts through an unauthenticated network service.

The legacy `conversation-anchor.json` and `conversation-exclusions.json` runtime files remain supported for existing integrations, but unknown legacy anchor IDs fail closed. New integrations should use the versioned context plan.
