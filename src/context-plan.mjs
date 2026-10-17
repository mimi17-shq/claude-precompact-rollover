import { estimateTokens } from "./core.mjs";

export const CONTEXT_PLAN_VERSION = 1;
export const HIDDEN_USER_PLACEHOLDER = '<context-omitted role="user" />';
export const HIDDEN_ASSISTANT_PLACEHOLDER = [{ type: "text", text: '<context-omitted role="assistant" />' }];

function uniqueIds(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256) {
      throw new Error(`${field}[${index}] must be a non-empty message id`);
    }
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicates`);
  return ids;
}

export function normalizeContextPlan(input, { sourceSessionId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("context plan must be an object");
  }
  if (input.version !== CONTEXT_PLAN_VERSION) {
    throw new Error(`context plan version must be ${CONTEXT_PLAN_VERSION}`);
  }
  const allowedFields = new Set([
    "version", "sourceSessionId", "retainTokens", "pinnedMessageIds", "hiddenMessageIds", "nextWindow",
  ]);
  const unknownFields = Object.keys(input).filter(field => !allowedFields.has(field));
  if (unknownFields.length) throw new Error(`context plan has unknown fields: ${unknownFields.join(",")}`);
  const sessionId = String(input.sourceSessionId || "").trim();
  if (!sessionId) throw new Error("context plan sourceSessionId is required");
  if (sessionId.length > 256) throw new Error("context plan sourceSessionId is too long");
  if (sourceSessionId && sessionId !== sourceSessionId) {
    throw new Error("context plan sourceSessionId does not match the requested session");
  }
  const retainTokens = input.retainTokens === undefined ? null : Number(input.retainTokens);
  if (retainTokens !== null && (!Number.isInteger(retainTokens) || retainTokens < 1_000 || retainTokens > 100_000)) {
    throw new Error("context plan retainTokens must be an integer from 1000 to 100000");
  }
  const nextWindow = input.nextWindow === undefined ? {} : input.nextWindow;
  if (!nextWindow || typeof nextWindow !== "object" || Array.isArray(nextWindow)) {
    throw new Error("context plan nextWindow must be an object");
  }
  const unknownNextFields = Object.keys(nextWindow).filter(field => !new Set(["model", "effort"]).has(field));
  if (unknownNextFields.length) {
    throw new Error(`context plan nextWindow has unknown fields: ${unknownNextFields.join(",")}`);
  }
  for (const field of ["model", "effort"]) {
    if (nextWindow[field] !== undefined && typeof nextWindow[field] !== "string") {
      throw new Error(`context plan nextWindow.${field} must be a string`);
    }
  }
  return {
    version: CONTEXT_PLAN_VERSION,
    sourceSessionId: sessionId,
    retainTokens,
    pinnedMessageIds: uniqueIds(input.pinnedMessageIds, "pinnedMessageIds"),
    hiddenMessageIds: uniqueIds(input.hiddenMessageIds, "hiddenMessageIds"),
    nextWindow: {
      model: String(nextWindow.model || "").trim(),
      effort: String(nextWindow.effort || "").trim(),
    },
  };
}

export function inspectPlanIds(plan, availableMessageIds) {
  const available = availableMessageIds instanceof Set ? availableMessageIds : new Set(availableMessageIds);
  const missingPinnedMessageIds = plan.pinnedMessageIds.filter(id => !available.has(id));
  const missingHiddenMessageIds = plan.hiddenMessageIds.filter(id => !available.has(id));
  const hidden = new Set(plan.hiddenMessageIds);
  return {
    missingPinnedMessageIds,
    missingHiddenMessageIds,
    pinHideConflicts: plan.pinnedMessageIds.filter(id => hidden.has(id)),
  };
}

export function assertPlanIds(plan, availableMessageIds) {
  const result = inspectPlanIds(plan, availableMessageIds);
  const missing = [...result.missingPinnedMessageIds, ...result.missingHiddenMessageIds];
  if (missing.length) throw new Error(`context plan references missing message ids: ${missing.join(",")}`);
  return result;
}

export function assistantMessagesForTurn(turn) {
  const messages = Array.isArray(turn?.assistantMessages)
    ? turn.assistantMessages.filter(message => message?.id && Array.isArray(message?.content))
    : [];
  if (messages.length) return messages;
  return turn?.assistantId && Array.isArray(turn?.assistantContent)
    ? [{ id: String(turn.assistantId), content: turn.assistantContent }]
    : [];
}

export function turnMessageIds(turn) {
  return [...new Set([
    String(turn?.userId || ""),
    String(turn?.assistantId || ""),
    ...assistantMessagesForTurn(turn).map(message => String(message.id)),
  ].filter(Boolean))];
}

export function visibleContextTurn(turn, {
  recent = false,
  pinnedMessageIds = [],
  hiddenMessageIds = [],
} = {}) {
  const pinned = pinnedMessageIds instanceof Set ? pinnedMessageIds : new Set(pinnedMessageIds);
  const hidden = hiddenMessageIds instanceof Set ? hiddenMessageIds : new Set(hiddenMessageIds);
  const userId = String(turn.userId || "");
  const finalAssistantId = String(turn.assistantId || "");
  const assistantMessages = assistantMessagesForTurn(turn);
  const userVisible = !hidden.has(userId) && (recent || pinned.has(userId));
  const finalAliasVisible = Boolean(turn?.assistantIdAggregatesMessages) && finalAssistantId && !hidden.has(finalAssistantId)
    && (recent || pinned.has(finalAssistantId));
  const visibleAssistantMessages = hidden.has(finalAssistantId) ? [] : assistantMessages.filter(message => {
    const id = String(message.id);
    return !hidden.has(id) && (recent || finalAliasVisible || pinned.has(id));
  });
  const assistantVisible = visibleAssistantMessages.length > 0;
  return {
    userVisible,
    assistantVisible,
    userContent: userVisible ? turn.userContent : HIDDEN_USER_PLACEHOLDER,
    assistantContent: assistantVisible
      ? visibleAssistantMessages.flatMap(message => message.content)
      : HIDDEN_ASSISTANT_PLACEHOLDER,
    visibleAssistantMessageIds: visibleAssistantMessages.map(message => String(message.id)),
  };
}

export function selectContextTurns(turns, {
  retainTokens,
  pinnedMessageIds = [],
  hiddenMessageIds = [],
} = {}) {
  if (!Number.isInteger(retainTokens) || retainTokens < 1_000 || retainTokens > 100_000) {
    throw new Error("retainTokens must be an integer from 1000 to 100000");
  }
  const pinned = new Set(pinnedMessageIds);
  const hidden = new Set(hiddenMessageIds);
  const pinnedTurnIds = new Set();
  for (const turn of turns) {
    if (turnMessageIds(turn).some(id => pinned.has(id))) {
      pinnedTurnIds.add(String(turn.id));
    }
  }
  const selectedTurnIds = new Set(pinnedTurnIds);
  const recentTurnIds = new Set();
  const visibleEstimate = (turn, recent) => {
    const visible = visibleContextTurn(turn, {
      recent,
      pinnedMessageIds: pinned,
      hiddenMessageIds: hidden,
    });
    if (!visible.userVisible && !visible.assistantVisible) return 0;
    return estimateTokens(visible.userContent) + estimateTokens(visible.assistantContent);
  };
  let estimatedTokens = turns
    .filter(turn => selectedTurnIds.has(String(turn.id)))
    .reduce((sum, turn) => sum + visibleEstimate(turn, false), 0);
  const latestTurnId = turns.length ? String(turns[turns.length - 1].id) : "";
  for (let index = turns.length - 1;
    index >= 0 && (estimatedTokens < retainTokens || (latestTurnId && !recentTurnIds.has(latestTurnId)));
    index -= 1) {
    const turn = turns[index];
    const id = String(turn.id);
    const pinnedOnlyEstimate = selectedTurnIds.has(id) ? visibleEstimate(turn, false) : 0;
    const estimate = visibleEstimate(turn, true);
    if (!estimate) continue;
    selectedTurnIds.add(id);
    recentTurnIds.add(id);
    estimatedTokens += estimate - pinnedOnlyEstimate;
  }
  return {
    selectedTurnIds,
    pinnedTurnIds,
    recentTurnIds,
    estimatedTokens,
    hiddenWins: true,
  };
}

export function typedTurnsFromEntries(entries, { deliveryToolNames = [] } = {}) {
  const deliveryTools = deliveryToolNames instanceof Set
    ? deliveryToolNames
    : new Set(deliveryToolNames);
  const byUuid = new Map(entries.filter(entry => entry?.uuid).map(entry => [String(entry.uuid), entry]));
  const humans = entries.filter(entry => entry?.type === "user"
    && entry?.isCompactSummary !== true
    && entry?.origin?.kind === "human"
    && entry?.promptSource === "typed"
    && !entry?.isMeta
    && typeof entry?.message?.content === "string");
  const humanIds = new Set(humans.map(entry => String(entry.uuid)));
  const ancestorId = entry => {
    let cursor = byUuid.get(String(entry?.parentUuid || ""));
    const seen = new Set();
    while (cursor?.uuid && !seen.has(String(cursor.uuid))) {
      const id = String(cursor.uuid);
      seen.add(id);
      if (humanIds.has(id)) return id;
      cursor = byUuid.get(String(cursor?.parentUuid || ""));
    }
    return "";
  };
  const finalByHuman = new Map();
  const textualByHuman = new Map();
  const deliveredByHuman = new Map();
  for (const entry of entries) {
    if (entry?.type !== "assistant" || !Array.isArray(entry?.message?.content)) continue;
    const text = entry.message.content.filter(block => block?.type === "text" && typeof block?.text === "string");
    const humanId = ancestorId(entry);
    if (!humanId) continue;
    if (text.length) {
      textualByHuman.set(humanId, [...(textualByHuman.get(humanId) || []), {
        id: String(entry.uuid), content: text,
      }]);
    }
    const delivered = entry.message.content
      .filter(block => block?.type === "tool_use"
        && deliveryTools.has(String(block?.name || ""))
        && typeof block?.input?.text === "string"
        && block.input.text.trim())
      .map(block => ({ id: String(entry.uuid), content: [{ type: "text", text: block.input.text.trim() }] }));
    if (delivered.length) deliveredByHuman.set(humanId, [...(deliveredByHuman.get(humanId) || []), ...delivered]);
    if (!text.length || !new Set(["end_turn", "stop_sequence"]).has(entry?.message?.stop_reason)) continue;
    if (humanId) finalByHuman.set(humanId, entry);
  }
  return humans.flatMap(human => {
    const assistant = finalByHuman.get(String(human.uuid));
    if (!assistant) return [];
    const assistantMessages = deliveredByHuman.get(String(human.uuid))
      || textualByHuman.get(String(human.uuid))
      || [{ id: String(assistant.uuid || ""), content: assistant.message.content }];
    return [{
      id: String(human.uuid),
      userId: String(human.uuid),
      assistantId: String(assistant.uuid || ""),
      userContent: human.message.content,
      assistantContent: assistant.message.content,
      assistantMessages,
      assistantIdAggregatesMessages: deliveredByHuman.has(String(human.uuid)),
    }];
  });
}
