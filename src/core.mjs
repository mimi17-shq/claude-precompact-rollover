import { createHash } from "node:crypto";

export const DEFAULT_CONFIG = Object.freeze({
  retainTokens: 12_000,
  defaultProfile: "200k",
  oneMillionModels: [],
  nextWindow: { model: "", effort: "" },
  pollSeconds: 2,
  stableSeconds: 15,
  profiles: {
    "200k": {
      contextWindow: 200_000,
      prepareAt: 140_000,
      warnAt: 155_000,
      rolloverAt: 160_000,
      autoRollover: true,
    },
    "1m": {
      contextWindow: 1_000_000,
      autoRollover: false,
    },
  },
  prepare: {
    message: "Context is filling. Ask the current model to save durable memories before rollover.",
  },
});

export function mergeConfig(input = {}) {
  const profiles = {};
  for (const [name, base] of Object.entries(DEFAULT_CONFIG.profiles)) {
    profiles[name] = { ...base, ...(input.profiles?.[name] || {}) };
  }
  for (const [name, profile] of Object.entries(input.profiles || {})) {
    if (!profiles[name]) profiles[name] = { ...profile };
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    profiles,
    nextWindow: { ...DEFAULT_CONFIG.nextWindow, ...(input.nextWindow || {}) },
    prepare: { ...DEFAULT_CONFIG.prepare, ...(input.prepare || {}) },
    oneMillionModels: Array.isArray(input.oneMillionModels) ? [...input.oneMillionModels] : [],
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!Number.isInteger(config.retainTokens) || config.retainTokens < 1_000 || config.retainTokens > 100_000) {
    throw new Error("retainTokens must be an integer from 1000 to 100000");
  }
  if (!(Number(config.pollSeconds) > 0) || !(Number(config.stableSeconds) >= 5)) {
    throw new Error("pollSeconds must be positive and stableSeconds must be at least 5");
  }
  if (!config.profiles?.[config.defaultProfile]) throw new Error("defaultProfile does not exist");
  for (const [name, profile] of Object.entries(config.profiles || {})) {
    if (profile.autoRollover === false) continue;
    const values = [profile.prepareAt, profile.warnAt, profile.rolloverAt, profile.contextWindow];
    if (!values.every(Number.isFinite)) throw new Error(`profile ${name} has incomplete thresholds`);
    if (!(profile.prepareAt < profile.warnAt && profile.warnAt < profile.rolloverAt
      && profile.rolloverAt < profile.contextWindow)) {
      throw new Error(`profile ${name} thresholds must be strictly increasing`);
    }
  }
}

export function profileForModel(model, config) {
  const normalized = String(model || "").toLowerCase();
  const isOneMillion = config.oneMillionModels.some(pattern => {
    if (typeof pattern !== "string" || !pattern) return false;
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const end = pattern.lastIndexOf("/");
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(normalized);
    }
    return normalized === pattern.toLowerCase();
  });
  const name = isOneMillion ? "1m" : config.defaultProfile;
  return { name, ...config.profiles[name] };
}

export function usageTokens(usage = {}) {
  const fields = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  return fields.reduce((sum, key) => sum + Math.max(0, Number(usage?.[key]) || 0), 0);
}

export function parseJsonl(text) {
  const entries = [];
  const invalidLines = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      invalidLines.push(index + 1);
    }
  }
  return { entries, invalidLines };
}

export function inspectEntries(entries) {
  let tokens = 0;
  let model = "";
  let compactCount = 0;
  let lastCompactIndex = -1;
  let latestAssistant = null;
  for (const [index, entry] of entries.entries()) {
    if (entry?.type === "system" && entry?.subtype === "compact_boundary") {
      compactCount += 1;
      lastCompactIndex = index;
    }
    if (entry?.type !== "assistant") continue;
    latestAssistant = entry;
    const current = usageTokens(entry?.message?.usage);
    if (current) tokens = current;
    if (entry?.message?.model) model = String(entry.message.model);
  }
  const stopReason = latestAssistant?.message?.stop_reason || "";
  return {
    tokens,
    model,
    compactCount,
    lastCompactIndex,
    idleAfterFinal: stopReason === "end_turn" || stopReason === "stop_sequence",
    latestStopReason: stopReason,
  };
}

export function decideAction(snapshot, profile, state = {}) {
  if (snapshot.compactCount > (state.handledCompactCount || 0)) {
    return profile.autoRollover === false
      ? { action: "manual_rescue_available", reason: "new_compaction_detected_auto_disabled" }
      : { action: "rescue", reason: "new_compaction_detected" };
  }
  if (profile.autoRollover === false) return { action: "none", reason: "auto_rollover_disabled" };
  if (snapshot.tokens >= profile.rolloverAt) {
    return snapshot.idleAfterFinal
      ? { action: "rollover", reason: "rollover_threshold" }
      : { action: "wait", reason: "waiting_for_complete_reply" };
  }
  if (snapshot.tokens >= profile.warnAt && !state.warned) {
    return { action: "warn", reason: "warning_threshold" };
  }
  if (snapshot.tokens >= profile.prepareAt && !state.prepared) {
    return { action: "prepare", reason: "prepare_threshold" };
  }
  return { action: "none", reason: "below_threshold" };
}

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let ascii = 0;
  for (const char of text) if (char.charCodeAt(0) < 128) ascii += 1;
  return Math.ceil(ascii / 4) + (text.length - ascii);
}

export function selectRecentTurns(turns, tokenBudget, anchoredIds = new Set()) {
  const keep = new Set(anchoredIds);
  let estimatedTokens = turns
    .filter(turn => keep.has(String(turn.id)))
    .reduce((sum, turn) => sum + estimateTokens(turn.user) + estimateTokens(turn.assistant), 0);
  for (let index = turns.length - 1; index >= 0 && estimatedTokens < tokenBudget; index -= 1) {
    const turn = turns[index];
    if (keep.has(String(turn.id))) continue;
    keep.add(String(turn.id));
    estimatedTokens += estimateTokens(turn.user) + estimateTokens(turn.assistant);
  }
  return {
    turns: turns.filter(turn => keep.has(String(turn.id))),
    estimatedTokens,
  };
}

export function contentDigest(turns) {
  return createHash("sha256").update(JSON.stringify(turns.map(turn => [turn.user, turn.assistant]))).digest("hex");
}
