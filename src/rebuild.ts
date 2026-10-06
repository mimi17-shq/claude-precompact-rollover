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

const sourceSessionId = process.argv[2];
const dir = path.resolve(process.argv[3] || process.cwd());
const sourceMode = process.argv[4] || "typed";
const runtimeDir = process.argv[5] || path.join(dir, "rebuild-runtime");
const overlaySessionId = process.argv[6] || "";
const forceRecentTokens = Math.max(1000, Math.min(100000, Number(
  process.env.ROLLOVER_RETAIN_TOKENS || process.env.THREAD_REBUILD_FORCE_RECENT_TOKENS || 12000,
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
const anchorHumanUuids = new Set<string>();
try {
  const loaded = JSON.parse(await readFile(path.join(runtimeDir, "conversation-anchor.json"), "utf8"));
  anchorConfigs = Array.isArray(loaded) ? loaded : loaded ? [loaded] : [];
  for (const anchor of anchorConfigs) {
    const anchorUuid = String(anchor?.source_uuid || "");
    if (anchorUuid) anchorMessageUuids.add(anchorUuid);
    const direct = allHumans.find(human => String(human.uuid) === anchorUuid);
    const ancestor = direct || humanAncestor(byUuid.get(anchorUuid));
    if (ancestor?.uuid) anchorHumanUuids.add(String(ancestor.uuid));
  }
} catch {}

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
} catch {}

const estimateTokens = (value: unknown): number => {
  const text = JSON.stringify(value ?? "");
  let ascii = 0;
  for (const char of text) if (char.charCodeAt(0) < 128) ascii += 1;
  return Math.ceil(ascii / 4) + (text.length - ascii);
};
const omittedUserContent = '<thread-rebuild-omitted role="user" />';
const omittedAssistantContent = [{ type: "text", text: "<thread-rebuild-omitted role=\"assistant\" />" }];
const normalTurnUuids = new Set<string>();
const eligibleHumans = forceScopedHumans.filter((human) => {
  const uuid = String(human.uuid);
  normalTurnUuids.add(uuid);
  return true;
});
const retainedTokenEstimate = (human: any, normal: boolean): number => {
  const humanUuid = String(human?.uuid || "");
  const assistant = finalByHuman.get(humanUuid);
  const assistantUuid = String(assistant?.uuid || "");
  const keepHuman = !excludedMessageUuids.has(humanUuid) && (normal || anchorMessageUuids.has(humanUuid));
  const keepAssistant = Boolean(assistant) && !excludedMessageUuids.has(assistantUuid)
    && (normal || anchorMessageUuids.has(assistantUuid));
  if (!keepHuman && !keepAssistant) return 0;
  return estimateTokens(keepHuman ? human?.message?.content : omittedUserContent)
    + (assistant ? estimateTokens(keepAssistant ? assistant?.message?.content : omittedAssistantContent) : 0);
};
let humans = eligibleHumans;
if (forceRecentTokens) {
  const keep = new Set<string>(anchorHumanUuids);
  normalTurnUuids.clear();
  let estimated = eligibleHumans
    .filter(human => keep.has(String(human.uuid)))
    .reduce((sum, human) => sum + retainedTokenEstimate(human, false), 0);
  for (let index = eligibleHumans.length - 1; index >= 0 && estimated < forceRecentTokens; index -= 1) {
    const human = eligibleHumans[index];
    const uuid = String(human.uuid);
    if (keep.has(uuid)) continue;
    keep.add(uuid);
    normalTurnUuids.add(uuid);
    estimated += retainedTokenEstimate(human, true);
  }
  humans = eligibleHumans.filter(human => keep.has(String(human.uuid)));
}

const retainedHumans: any[] = [];
const retainedFinalByHuman = new Map<string, any>();
for (const sourceHuman of humans) {
  const uuid = String(sourceHuman.uuid);
  const sourceAssistant = finalByHuman.get(uuid);
  const assistantUuid = String(sourceAssistant?.uuid || "");
  const normal = normalTurnUuids.has(uuid);
  const keepHuman = !excludedMessageUuids.has(uuid) && (normal || anchorMessageUuids.has(uuid));
  const keepAssistant = Boolean(sourceAssistant) && !excludedMessageUuids.has(assistantUuid)
    && (normal || anchorMessageUuids.has(assistantUuid));
  if (!keepHuman && !keepAssistant) continue;
  const human = structuredClone(sourceHuman);
  if (!keepHuman) human.message = { ...structuredClone(human.message), content: omittedUserContent };
  retainedHumans.push(human);
  if (sourceAssistant) {
    const assistant = structuredClone(sourceAssistant);
    if (!keepAssistant) assistant.message = { ...structuredClone(assistant.message), content: omittedAssistantContent };
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

const anchorTargets: any[] = [];
for (const anchor of anchorConfigs) {
 try {
  const sourceSequence = humans.flatMap(human => {
    const assistant = finalByHuman.get(String(human.uuid));
    return assistant ? [human, assistant] : [human];
  });
  const anchorIndex = sourceSequence.findIndex(entry => String(entry?.uuid || "") === String(anchor?.source_uuid || ""));
  if (anchorIndex >= 0 && linked[anchorIndex]?.uuid) {
    anchorTargets.push({
      ...anchor,
      session_id: targetSessionId,
      source_uuid: linked[anchorIndex].uuid,
      previous_session_id: sourceSessionId,
      previous_source_uuid: anchor.source_uuid,
      rolled_at: new Date().toISOString(),
    });
  }
 } catch {}
}

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
};
await writeFile(path.join(runtimeDir, "candidate-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
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
