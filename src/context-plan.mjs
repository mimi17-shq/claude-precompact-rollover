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
    if (pinned.has(String(turn.userId)) || pinned.has(String(turn.assistantId))) {
      pinnedTurnIds.add(String(turn.id));
    }
  }
  const selectedTurnIds = new Set(pinnedTurnIds);
  const recentTurnIds = new Set();
  const visibleEstimate = (turn, recent) => {
    const userVisible = !hidden.has(String(turn.userId))
      && (recent || pinned.has(String(turn.userId)));
    const assistantVisible = !hidden.has(String(turn.assistantId))
      && (recent || pinned.has(String(turn.assistantId)));
    if (!userVisible && !assistantVisible) return 0;
    return estimateTokens(userVisible ? turn.userContent : HIDDEN_USER_PLACEHOLDER)
      + estimateTokens(assistantVisible ? turn.assistantContent : HIDDEN_ASSISTANT_PLACEHOLDER);
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

export function typedTurnsFromEntries(entries) {
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
  for (const entry of entries) {
    if (entry?.type !== "assistant" || !Array.isArray(entry?.message?.content)) continue;
    const text = entry.message.content.filter(block => block?.type === "text" && typeof block?.text === "string");
    if (!text.length || !new Set(["end_turn", "stop_sequence"]).has(entry?.message?.stop_reason)) continue;
    const humanId = ancestorId(entry);
    if (humanId) finalByHuman.set(humanId, entry);
  }
  return humans.flatMap(human => {
    const assistant = finalByHuman.get(String(human.uuid));
    if (!assistant) return [];
    return [{
      id: String(human.uuid),
      userId: String(human.uuid),
      assistantId: String(assistant.uuid || ""),
      userContent: human.message.content,
      assistantContent: assistant.message.content,
    }];
  });
}
