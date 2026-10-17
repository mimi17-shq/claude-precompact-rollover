#!/usr/bin/env bun
import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertPlanIds,
  HIDDEN_ASSISTANT_PLACEHOLDER,
  HIDDEN_USER_PLACEHOLDER,
  normalizeContextPlan,
  selectContextTurns,
  turnMessageIds,
  visibleContextTurn,
} from "./context-plan.mjs";

const sourceSessionId = process.argv[2];
const dir = path.resolve(process.argv[3] || process.cwd());
const sourceMode = process.argv[4] || "typed";
const runtimeDir = process.argv[5] || path.join(dir, "rebuild-runtime");
const overlaySessionId = process.argv[6] || "";
const contextPlanPath = String(process.env.ROLLOVER_CONTEXT_PLAN_PATH || "").trim();
let contextPlan: ReturnType<typeof normalizeContextPlan> | null = null;
if (contextPlanPath) {
  contextPlan = normalizeContextPlan(JSON.parse(await readFile(path.resolve(contextPlanPath), "utf8")), {
    sourceSessionId,
  });
}
const forceRecentTokens = Math.max(1000, Math.min(100000, Number(
  process.env.ROLLOVER_RETAIN_TOKENS || contextPlan?.retainTokens
    || process.env.THREAD_REBUILD_FORCE_RECENT_TOKENS || 12000,
)));
const nextModel = String(process.env.ROLLOVER_NEXT_MODEL || "").trim();
const nextEffort = String(process.env.ROLLOVER_NEXT_EFFORT || "").trim();
const deliveryToolNames = new Set(String(process.env.ROLLOVER_DELIVERY_TOOLS || "")
  .split(",").map(value => value.trim()).filter(Boolean));
const forceChatScopePath = process.env.THREAD_REBUILD_FORCE_CHAT_SCOPE_PATH
  || path.join(runtimeDir, "force-retained-chat-scope.json");
const excludedChatScopePath = process.env.THREAD_REBUILD_EXCLUDED_CHAT_SCOPE_PATH
  || path.join(runtimeDir, "rebuild-excluded-chat-scope.json");
const projectKey = dir.replace(/[^A-Za-z0-9]/g, "-");
const claudeConfigDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"));
const transcriptDir = path.resolve(process.env.ROLLOVER_TRANSCRIPT_DIR || path.join(claudeConfigDir, "projects", projectKey));
if (!sourceSessionId) throw new Error("missing source session id");
if (!new Set(["typed", "channel"]).has(sourceMode)) throw new Error("invalid source mode");

const raw: any[] = [];
const importStore = {
  async append(_key: any, entries: any[]) {
    raw.push(...structuredClone(entries));
  },
  async load(_key: any) {
    return null;
  },
};

await importSessionToStore(sourceSessionId, importStore, {
  dir,
  includeSubagents: false,
  batchSize: 200,
});

const byUuid = new Map(raw.filter(e => e?.uuid).map(e => [String(e.uuid), e]));
function isWrappedHuman(entry: any): boolean {
  const content = entry?.message?.content;
  return entry?.origin?.kind === "human"
    && entry?.promptSource === "typed"
    && typeof content === "string"
    && /^\s*<chat-input\b[^>]*\/>/s.test(content);
}
function isOmittedRebuildHuman(entry: any): boolean {
  return entry?.threadRebuildSource === true
    && entry?.origin?.kind === "human"
    && entry?.promptSource === "typed"
    && entry?.message?.content === '<thread-rebuild-omitted role="user" />';
}
const allHumans = raw.filter(e =>
  e?.type === "user" &&
  e?.isCompactSummary !== true &&
  (sourceMode === "typed"
    ? e?.origin?.kind === "human" && e?.promptSource === "typed"
    : (e?.origin?.kind === "channel" && e?.promptSource === "system") || isWrappedHuman(e) || e?.threadRebuildSource === true) &&
  (sourceMode === "channel" || !e?.isMeta) &&
  typeof e?.message?.content === "string"
);

function humanAncestor(entry: any): any | null {
  let cursor = byUuid.get(String(entry?.parentUuid || ""));
  const seen = new Set<string>();
  while (cursor?.uuid && !seen.has(String(cursor.uuid))) {
    seen.add(String(cursor.uuid));
    if (allHumans.some(h => h.uuid === cursor.uuid)) return cursor;
    cursor = byUuid.get(String(cursor?.parentUuid || ""));
  }
  return null;
}

const finalByHuman = new Map<string, any>();
const deliveredByHuman = new Map<string, string[]>();
for (const entry of raw) {
  if (entry?.type !== "assistant" || !Array.isArray(entry?.message?.content)) continue;
  const delivered = entry.message.content
    .filter((block: any) => block?.type === "tool_use" && deliveryToolNames.has(String(block?.name || "")) && typeof block?.input?.text === "string")
    .map((block: any) => String(block.input.text).trim())
    .filter(Boolean);
  if (!delivered.length) continue;
  const human = humanAncestor(entry);
  if (!human?.uuid) continue;
  const key = String(human.uuid);
  deliveredByHuman.set(key, [...(deliveredByHuman.get(key) || []), ...delivered]);
}

type AssistantMessage = { id: string; content: any[] };
const textualMessagesByHuman = new Map<string, AssistantMessage[]>();
const deliveredMessagesByHuman = new Map<string, AssistantMessage[]>();
for (const entry of raw) {
  if (entry?.type !== "assistant" || !entry?.uuid || !Array.isArray(entry?.message?.content)) continue;
  const human = humanAncestor(entry);
  if (!human?.uuid) continue;
  const humanId = String(human.uuid);
  const textBlocks = entry.message.content
    .filter((block: any) => block?.type === "text" && typeof block?.text === "string");
  if (textBlocks.length) {
    textualMessagesByHuman.set(humanId, [...(textualMessagesByHuman.get(humanId) || []), {
      id: String(entry.uuid), content: structuredClone(textBlocks),
    }]);
  }
  const deliveredBlocks = entry.message.content
    .filter((block: any) => block?.type === "tool_use"
      && deliveryToolNames.has(String(block?.name || ""))
      && typeof block?.input?.text === "string"
      && block.input.text.trim())
    .map((block: any) => ({ type: "text", text: String(block.input.text).trim() }));
  if (deliveredBlocks.length) {
    deliveredMessagesByHuman.set(humanId, [...(deliveredMessagesByHuman.get(humanId) || []), {
      id: String(entry.uuid), content: deliveredBlocks,
    }]);
  }
}

function assistantMessagesForHuman(humanId: string): AssistantMessage[] {
  const assistant = finalByHuman.get(humanId);
  const messages = deliveredMessagesByHuman.get(humanId)
    || textualMessagesByHuman.get(humanId);
  if (messages?.length) return messages;
  return assistant?.uuid && Array.isArray(assistant?.message?.content)
    ? [{ id: String(assistant.uuid), content: structuredClone(assistant.message.content) }]
    : [];
}

let overlayTurns = 0;
if (overlaySessionId) {
  const overlayRaw: any[] = [];
  const overlayStore = {
    async append(_key: any, entries: any[]) { overlayRaw.push(...structuredClone(entries)); },
    async load(_key: any) { return null; },
  };
  await importSessionToStore(overlaySessionId, overlayStore, { dir, includeSubagents: false, batchSize: 200 });
  const overlayByUuid = new Map(overlayRaw.filter(e => e?.uuid).map(e => [String(e.uuid), e]));
  const overlayHumans = overlayRaw.filter(e => e?.type === "user" && e?.isCompactSummary !== true &&
    ((e?.origin?.kind === "channel" && e?.promptSource === "system") || e?.threadRebuildSource === true) &&
    typeof e?.message?.content === "string");
  const overlayHumanUuids = new Set(overlayHumans.map(e => String(e.uuid)));
  const overlayAncestor = (entry: any): any | null => {
    let cursor = overlayByUuid.get(String(entry?.parentUuid || ""));
    const seen = new Set<string>();
    while (cursor?.uuid && !seen.has(String(cursor.uuid))) {
      seen.add(String(cursor.uuid));
      if (overlayHumanUuids.has(String(cursor.uuid))) return cursor;
      cursor = overlayByUuid.get(String(cursor?.parentUuid || ""));
    }
    return null;
  };
  const overlayDelivered = new Map<string, string[]>();
  for (const entry of overlayRaw) {
    if (entry?.type !== "assistant" || !Array.isArray(entry?.message?.content)) continue;
    const texts = entry.message.content
      .filter((block: any) => block?.type === "tool_use" && deliveryToolNames.has(String(block?.name || "")) && typeof block?.input?.text === "string")
      .map((block: any) => String(block.input.text).trim()).filter(Boolean);
    const human = texts.length ? overlayAncestor(entry) : null;
    if (human?.uuid) overlayDelivered.set(String(human.uuid), [...(overlayDelivered.get(String(human.uuid)) || []), ...texts]);
  }
  const overlayFinal = new Map<string, any>();
  for (const entry of overlayRaw) {
    if (entry?.type !== "assistant") continue;
    const human = overlayAncestor(entry);
    const texts = human?.uuid ? overlayDelivered.get(String(human.uuid)) || [] : [];
    const stopReason = entry?.message?.stop_reason;
    const terminal = stopReason === "end_turn" || (stopReason === "stop_sequence" && texts.length > 0);
    if (!terminal || !human?.uuid || !texts.length) continue;
    overlayFinal.set(String(human.uuid), {
      ...structuredClone(entry),
      message: { ...structuredClone(entry.message), stop_reason: "end_turn", content: [{ type: "text", text: texts.join("\n\n") }] },
    });
  }
  if (overlayHumans.length > allHumans.length) throw new Error("overlay has more human turns than source");
  for (let index = 0; index < overlayHumans.length; index += 1) {
    if (overlayHumans[index]?.message?.content !== allHumans[index]?.message?.content) {
      throw new Error(`overlay user mismatch at turn ${index + 1}`);
    }
    const assistant = overlayFinal.get(String(overlayHumans[index].uuid));
    if (assistant) {
      finalByHuman.set(String(allHumans[index].uuid), assistant);
      overlayTurns += 1;
    }
  }
}
for (const entry of raw) {
  if (entry?.type !== "assistant") continue;
  let textBlocks = Array.isArray(entry?.message?.content)
    ? entry.message.content.filter((block: any) => block?.type === "text" && typeof block?.text === "string")
    : [];
  const human = humanAncestor(entry);
  const delivered = human?.uuid ? deliveredByHuman.get(String(human.uuid)) || [] : [];
  const stopReason = entry?.message?.stop_reason;
  const terminal = stopReason === "end_turn" || (stopReason === "stop_sequence" && (delivered.length > 0 || textBlocks.length > 0));
  if (!terminal) continue;
  if (delivered.length) textBlocks = [{ type: "text", text: delivered.join("\n\n") }];
  if (!textBlocks.length) continue;
  if (human?.uuid && !finalByHuman.has(String(human.uuid))) {
    finalByHuman.set(String(human.uuid), {
      ...structuredClone(entry),
      message: { ...structuredClone(entry.message), stop_reason: "end_turn", content: textBlocks },
    });
  }
}

const turnDigest = (human: any, assistant: any | undefined): string => createHash("sha256")
  .update(JSON.stringify([human?.message?.content ?? null, assistant?.message?.content ?? null]))
  .digest("hex");
const humanDigest = (human: any): string => createHash("sha256")
  .update(JSON.stringify(human?.message?.content ?? null))
  .digest("hex");

const sourceTurnDigests = allHumans.map(human => turnDigest(human, finalByHuman.get(String(human.uuid))));
if (!forceRecentTokens) try {
  const baseline = JSON.parse(await readFile(path.join(runtimeDir, "inheritance-baseline.json"), "utf8"));
  const expected = Array.isArray(baseline?.turn_digests) ? baseline.turn_digests.map(String) : [];
  const expectedHumans = Array.isArray(baseline?.human_digests) ? baseline.human_digests.map(String) : [];
  const expectedAssistantPresent = Array.isArray(baseline?.assistant_present) ? baseline.assistant_present.map(Boolean) : [];
  let legacyUnpaired = 0;
  if (!expectedHumans.length && expected.length) {
    try {
      const priorManifest = JSON.parse(await readFile(path.join(runtimeDir, "candidate-manifest.json"), "utf8"));
      legacyUnpaired = Math.max(0, Number(priorManifest?.unpaired_users) || 0);
    } catch {}
  }
  const firstMismatch = expected.findIndex((value: string, index: number) => {
    if (expectedHumans.length === expected.length) {
      if (expectedHumans[index] !== humanDigest(allHumans[index])) return true;
      if (!expectedAssistantPresent[index] || value === sourceTurnDigests[index]) return false;
      // The final baseline turn can race with an external delivery adapter.
      // Keep its user text strict, but accept a later delivered representation.
      return index !== expected.length - 1 || !(deliveredByHuman.get(String(allHumans[index]?.uuid)) || []).length;
    }
    return value !== sourceTurnDigests[index] && index < expected.length - legacyUnpaired;
  });
  if (expected.length > sourceTurnDigests.length || firstMismatch >= 0) {
    throw new Error(`inheritance baseline mismatch: expected_prefix=${expected.length} source_turns=${sourceTurnDigests.length} first_mismatch=${firstMismatch + 1}`);
  }
} catch (error: any) {
  if (error?.code !== "ENOENT") throw error;
}

let anchorConfigs: any[] = [];
const anchorMessageUuids = new Set<string>();
try {
  const loaded = JSON.parse(await readFile(path.join(runtimeDir, "conversation-anchor.json"), "utf8"));
  anchorConfigs = Array.isArray(loaded) ? loaded : loaded ? [loaded] : [];
  for (const anchor of anchorConfigs) {
    const anchorUuid = String(anchor?.source_uuid || "");
    if (anchorUuid) anchorMessageUuids.add(anchorUuid);
  }
} catch (error: any) {
  if (error?.code !== "ENOENT") throw error;
}

const availableConversationMessageIds = new Set<string>();
for (const human of allHumans) {
  availableConversationMessageIds.add(String(human.uuid));
  const assistant = finalByHuman.get(String(human.uuid));
  if (assistant?.uuid) availableConversationMessageIds.add(String(assistant.uuid));
  for (const message of assistantMessagesForHuman(String(human.uuid))) {
    availableConversationMessageIds.add(message.id);
  }
}
const contextPlanIdCheck = contextPlan
  ? assertPlanIds(contextPlan, availableConversationMessageIds)
  : { pinHideConflicts: [] as string[] };
if (contextPlan) {
  for (const pinnedId of contextPlan.pinnedMessageIds) {
    // Pins are message-level. Selecting the containing turn keeps the graph
    // valid, while only this exact message is guaranteed to retain its text.
    anchorMessageUuids.add(pinnedId);
  }
}

function channelChatDigest(human: any): string {
  const content = human?.message?.content;
  if (typeof content !== "string") return "";
  const tag = content.match(/^\s*<channel\b([^>]*)>/s)?.[1] || "";
  const match = tag.match(/\bchat_id=(?:"([^"]+)"|'([^']+)')/);
  const chatId = match?.[1] ?? match?.[2] ?? "";
  return chatId ? createHash("sha256").update(chatId).digest("hex") : "";
}

let excludedChatDigests: Set<string> | null = null;
if (sourceMode === "channel") try {
  const config = JSON.parse(await readFile(excludedChatScopePath, "utf8"));
  const digests = Array.isArray(config?.excluded_chat_sha256)
    ? config.excluded_chat_sha256.map((value: unknown) => String(value).toLowerCase())
    : [];
  if (config?.version !== 1 || config?.policy !== "denylist" || !digests.length
      || digests.some((value: string) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("invalid rebuild excluded chat scope");
  }
  excludedChatDigests = new Set(digests);
} catch (error: any) {
  if (error?.code === "ENOENT") {
    throw new Error("rebuild excluded chat scope is required for channel rebuild");
  }
  throw error;
}

let forceAllowedChatDigests: Set<string> | null = null;
if (forceRecentTokens && sourceMode === "channel") try {
  const config = JSON.parse(await readFile(forceChatScopePath, "utf8"));
  const digests = Array.isArray(config?.allowed_chat_sha256)
    ? config.allowed_chat_sha256.map((value: unknown) => String(value).toLowerCase())
    : [];
  if (config?.version !== 1 || config?.policy !== "allowlist" || !digests.length
      || digests.some((value: string) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("invalid force retained chat scope");
  }
  forceAllowedChatDigests = new Set(digests);
} catch (error: any) {
  if (error?.code === "ENOENT") {
    throw new Error("force retained chat scope is required for forced rebuild");
  }
  throw error;
}

const channelChatDigests = sourceMode === "channel"
  ? allHumans.map(channelChatDigest)
  : [];
if (sourceMode === "channel" && channelChatDigests.some((value, index) =>
  !value && !isWrappedHuman(allHumans[index]) && !isOmittedRebuildHuman(allHumans[index])
)) {
  throw new Error("rebuild excluded chat scope could not classify every channel turn");
}
const permanentlyScopedHumans = excludedChatDigests
  ? allHumans.filter((human, index) =>
      isWrappedHuman(human) || isOmittedRebuildHuman(human) || !excludedChatDigests!.has(channelChatDigests[index]))
  : allHumans;
const excludedChatScopeTurns = allHumans.length - permanentlyScopedHumans.length;

const forceChatDigests = forceAllowedChatDigests
  ? channelChatDigests
  : [];
if (forceAllowedChatDigests && forceChatDigests.some((value, index) =>
  !value && !isWrappedHuman(allHumans[index]) && !isOmittedRebuildHuman(allHumans[index])
)) {
  throw new Error("force retained chat scope could not classify every channel turn");
}
const forceScopedHumans = forceAllowedChatDigests
  ? permanentlyScopedHumans.filter(human => {
      const index = allHumans.indexOf(human);
      return isWrappedHuman(human) || isOmittedRebuildHuman(human)
        || forceAllowedChatDigests!.has(forceChatDigests[index]);
    })
  : permanentlyScopedHumans;
const forceChatScopeExcludedTurns = permanentlyScopedHumans.length - forceScopedHumans.length;

const excludedMessageUuids = new Set<string>();
try {
  const exclusions = JSON.parse(await readFile(path.join(runtimeDir, "conversation-exclusions.json"), "utf8"));
  for (const item of Array.isArray(exclusions) ? exclusions : []) {
    const uuid = String(item?.source_uuid || "");
    if (uuid) excludedMessageUuids.add(uuid);
  }
} catch (error: any) {
  if (error?.code !== "ENOENT") throw error;
}
const missingLegacyAnchorIds = [...anchorMessageUuids]
  .filter(uuid => !availableConversationMessageIds.has(uuid));
if (missingLegacyAnchorIds.length) {
  throw new Error(`conversation anchors reference missing message ids: ${missingLegacyAnchorIds.join(",")}`);
}
for (const uuid of contextPlan?.hiddenMessageIds || []) excludedMessageUuids.add(uuid);

const estimateTokens = (value: unknown): number => {
  const text = JSON.stringify(value ?? "");
  let ascii = 0;
  for (const char of text) if (char.charCodeAt(0) < 128) ascii += 1;
  return Math.ceil(ascii / 4) + (text.length - ascii);
};
const omittedUserContent = HIDDEN_USER_PLACEHOLDER;
const omittedAssistantContent = HIDDEN_ASSISTANT_PLACEHOLDER;
const normalTurnUuids = new Set<string>();
const eligibleTurns = forceScopedHumans.map(human => {
  const assistant = finalByHuman.get(String(human.uuid));
  return {
    id: String(human.uuid),
    userId: String(human.uuid),
    assistantId: String(assistant?.uuid || ""),
    userContent: human?.message?.content,
    assistantContent: assistant?.message?.content,
    assistantMessages: assistantMessagesForHuman(String(human.uuid)),
    assistantIdAggregatesMessages: deliveredMessagesByHuman.has(String(human.uuid)),
  };
});
if (contextPlan) {
  assertPlanIds(contextPlan, new Set(eligibleTurns.flatMap(turnMessageIds)));
}
const turnSelection = selectContextTurns(eligibleTurns, {
  retainTokens: forceRecentTokens,
  pinnedMessageIds: [...anchorMessageUuids],
  hiddenMessageIds: [...excludedMessageUuids],
});
for (const turnId of turnSelection.recentTurnIds) normalTurnUuids.add(turnId);
let humans = forceScopedHumans.filter(human => turnSelection.selectedTurnIds.has(String(human.uuid)));

const retainedHumans: any[] = [];
const retainedFinalByHuman = new Map<string, any>();
for (const sourceHuman of humans) {
  const uuid = String(sourceHuman.uuid);
  const sourceAssistant = finalByHuman.get(uuid);
  const normal = normalTurnUuids.has(uuid);
  const sourceTurn = eligibleTurns.find(turn => turn.id === uuid)!;
  const visible = visibleContextTurn(sourceTurn, {
    recent: normal,
    pinnedMessageIds: anchorMessageUuids,
    hiddenMessageIds: excludedMessageUuids,
  });
  if (!visible.userVisible && !visible.assistantVisible) continue;
  const human = structuredClone(sourceHuman);
  if (!visible.userVisible) human.message = { ...structuredClone(human.message), content: omittedUserContent };
  retainedHumans.push(human);
  if (sourceAssistant) {
    const assistant = structuredClone(sourceAssistant);
    assistant.message = {
      ...structuredClone(assistant.message),
      content: visible.assistantVisible ? structuredClone(visible.assistantContent) : omittedAssistantContent,
    };
    retainedFinalByHuman.set(uuid, assistant);
  }
}
humans = retainedHumans;
finalByHuman.clear();
for (const [uuid, assistant] of retainedFinalByHuman) finalByHuman.set(uuid, assistant);
let estimatedRetainedTokens = humans.reduce((sum, human) =>
  sum + estimateTokens(human?.message?.content) + estimateTokens(finalByHuman.get(String(human.uuid))?.message?.content), 0);

const completePairs = humans
  .map(human => ({ human, assistant: finalByHuman.get(String(human.uuid)) }))
  .filter(pair => pair.assistant);
const unpairedIndices = humans
  .map((human, index) => finalByHuman.has(String(human.uuid)) ? -1 : index)
  .filter(index => index >= 0);

if (!completePairs.length || (sourceMode === "typed" && completePairs.length !== humans.length)) {
  throw new Error(`incomplete pairs: humans=${humans.length} complete=${completePairs.length} unpaired_indices=${unpairedIndices.join(",")}`);
}

const cleanSource: any[] = [];
const mode = raw.find(e => e?.type === "mode");
const permissionMode = raw.find(e => e?.type === "permission-mode");
if (mode) cleanSource.push(structuredClone(mode));
if (permissionMode) cleanSource.push(structuredClone(permissionMode));
let previousUuid: string | null = null;
let strippedInheritedUsageEntries = 0;
for (const sourceHuman of humans) {
  const sourceAssistant = finalByHuman.get(String(sourceHuman.uuid));
  const human = structuredClone(sourceHuman);
  if (sourceMode === "channel") {
    delete human.isMeta;
    human.origin = { kind: "human" };
    human.promptSource = "typed";
    human.threadRebuildSource = true;
  }
  human.parentUuid = previousUuid;
  cleanSource.push(human);
  previousUuid = String(human.uuid);
  if (sourceAssistant) {
    const assistant = structuredClone(sourceAssistant);
    // Usage belongs to the source model request, not to the retained text.
    // Carrying it into a rebuilt session can make a smaller target model see
    // the source window's high-water mark and compact immediately on resume.
    if (assistant?.message && typeof assistant.message === "object"
        && Object.prototype.hasOwnProperty.call(assistant.message, "usage")) {
      delete assistant.message.usage;
      strippedInheritedUsageEntries += 1;
    }
    assistant.parentUuid = human.uuid;
    cleanSource.push(assistant);
    previousUuid = String(assistant.uuid);
  }
}

const targetEntries: any[] = [];
let targetKey: any = null;
function sessionIdOf(key: any): string {
  return typeof key === "string" ? key : String(key?.sessionId || "");
}
const forkStore = {
  async append(key: any, entries: any[]) {
    targetKey = structuredClone(key);
    targetEntries.push(...structuredClone(entries));
  },
  async load(key: any) {
    if (sessionIdOf(key) === sourceSessionId) return structuredClone(cleanSource);
    if (targetKey && sessionIdOf(key) === sessionIdOf(targetKey)) {
      return structuredClone(targetEntries);
    }
    return null;
  },
};

const forked = await forkSession(sourceSessionId, {
  dir,
  sessionStore: forkStore,
  title: "Pre-compaction rollover",
});
const targetSessionId = forked.sessionId;
if (!targetEntries.length) throw new Error("fork produced no entries");

const linked = await getSessionMessages(targetSessionId, {
  dir,
  sessionStore: forkStore,
});
const linkedUsers = linked.filter(item => item.type === "user");
const linkedAssistants = linked.filter(item => item.type === "assistant");
if (linkedUsers.length !== humans.length || linkedAssistants.length !== completePairs.length) {
  throw new Error(`linked verification failed: users=${linkedUsers.length} assistants=${linkedAssistants.length}`);
}

function textDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const sourceDigest = textDigest(humans.flatMap(human => {
  const assistant = finalByHuman.get(String(human.uuid));
  return assistant
    ? [human.message.content, assistant.message.content]
    : [human.message.content];
}));
const targetDigest = textDigest(linked.map((item: any) => item.message?.content));
if (sourceDigest !== targetDigest) throw new Error("message digest mismatch");

const sourceToTargetMessageId = new Map<string, string>();
for (let index = 0; index < humans.length; index += 1) {
  const human = humans[index];
  const linkedUser = linkedUsers[index];
  const linkedAssistant = linkedAssistants[index];
  if (linkedUser?.uuid) sourceToTargetMessageId.set(String(human.uuid), String(linkedUser.uuid));
  if (linkedAssistant?.uuid) {
    const humanId = String(human.uuid);
    const finalAssistant = finalByHuman.get(humanId);
    if (finalAssistant?.uuid) sourceToTargetMessageId.set(String(finalAssistant.uuid), String(linkedAssistant.uuid));
    for (const message of assistantMessagesForHuman(humanId)) {
      sourceToTargetMessageId.set(message.id, String(linkedAssistant.uuid));
    }
  }
}
const anchorTargets: any[] = [];
for (const anchor of anchorConfigs) {
 try {
  const targetMessageId = sourceToTargetMessageId.get(String(anchor?.source_uuid || ""));
  if (targetMessageId) {
    anchorTargets.push({
      ...anchor,
      session_id: targetSessionId,
      source_uuid: targetMessageId,
      previous_session_id: sourceSessionId,
      previous_source_uuid: anchor.source_uuid,
      rolled_at: new Date().toISOString(),
    });
  }
 } catch {}
}
const pinnedMessageTargets = (contextPlan?.pinnedMessageIds || []).flatMap(sourceMessageId => {
  const targetMessageId = sourceToTargetMessageId.get(sourceMessageId);
  if (!targetMessageId) return [];
  return [{
    sourceMessageId,
    targetMessageId,
  }];
});

await mkdir(transcriptDir, { recursive: true, mode: 0o700 });
await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
const transcriptPath = path.join(transcriptDir, `${targetSessionId}.jsonl`);
await writeFile(transcriptPath, targetEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
const manifest = {
  version: 1,
  created_at: new Date().toISOString(),
  source_session_id: sourceSessionId,
  target_session_id: targetSessionId,
  source_raw_entries: raw.length,
  source_users: allHumans.length,
  excluded_turns: excludedMessageUuids.size,
  excluded_messages: excludedMessageUuids.size,
  force_recent_tokens: forceRecentTokens,
  next_model: nextModel || null,
  next_effort: nextEffort || null,
  force_chat_scope_enabled: Boolean(forceAllowedChatDigests),
  force_chat_scope_allowed_chats: forceAllowedChatDigests?.size || 0,
  force_chat_scope_excluded_turns: forceChatScopeExcludedTurns,
  excluded_chat_scope_enabled: Boolean(excludedChatDigests),
  excluded_chat_scope_chats: excludedChatDigests?.size || 0,
  excluded_chat_scope_turns: excludedChatScopeTurns,
  estimated_retained_tokens: estimatedRetainedTokens,
  stripped_inherited_usage_entries: strippedInheritedUsageEntries,
  retained_users: humans.length,
  retained_pairs: completePairs.length,
  delivered_reply_turns: deliveredByHuman.size,
  overlay_reply_turns: overlayTurns,
  unpaired_users: unpairedIndices.length,
  retained_entries: targetEntries.length,
  linked_users: linkedUsers.length,
  linked_assistants: linkedAssistants.length,
  source_digest: sourceDigest,
  target_digest: targetDigest,
  transcript_path: transcriptPath,
  anchor_targets: anchorTargets,
  context_plan_applied: Boolean(contextPlan),
  pinned_messages: contextPlan?.pinnedMessageIds.length || 0,
  hidden_messages: contextPlan?.hiddenMessageIds.length || 0,
  pin_hide_conflicts: contextPlanIdCheck.pinHideConflicts,
  pinned_message_targets: pinnedMessageTargets,
};
await writeFile(path.join(runtimeDir, "candidate-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
await writeFile(path.join(runtimeDir, "context-manifest.json"), JSON.stringify({
  version: 1,
  createdAt: manifest.created_at,
  sourceSessionId,
  targetSessionId,
  strategy: "recent-complete-turns-plus-message-pins",
  hidePrecedence: "hide-wins",
  retainTokens: forceRecentTokens,
  estimatedRetainedTokens,
  retainedTurns: humans.length,
  retainedPairs: completePairs.length,
  pinnedMessageIds: contextPlan?.pinnedMessageIds || [],
  hiddenMessageIds: contextPlan?.hiddenMessageIds || [],
  pinHideConflicts: contextPlanIdCheck.pinHideConflicts,
  pinnedMessageTargets,
  sourceDigest,
  targetDigest,
  digestMatch: sourceDigest === targetDigest,
}, null, 2) + "\n", { mode: 0o600 });
await writeFile(path.join(runtimeDir, "next-inheritance-baseline.json"), JSON.stringify({
  version: 2,
  session_id: targetSessionId,
  created_at: new Date().toISOString(),
  turn_digests: humans.map(human => turnDigest(human, finalByHuman.get(String(human.uuid)))),
  human_digests: humans.map(human => humanDigest(human)),
  assistant_present: humans.map(human => finalByHuman.has(String(human.uuid))),
}, null, 2) + "\n", { mode: 0o600 });
if (excludedMessageUuids.size) {
  await writeFile(path.join(runtimeDir, "consume-exclusions"), "ready\n", { mode: 0o600 });
}

console.log(JSON.stringify({
  ok: true,
  source_raw_entries: raw.length,
  retained_users: humans.length,
  retained_pairs: completePairs.length,
  unpaired_users: unpairedIndices.length,
  retained_entries: targetEntries.length,
  linked_users: linkedUsers.length,
  linked_assistants: linkedAssistants.length,
  digest_match: sourceDigest === targetDigest,
}, null, 2));
