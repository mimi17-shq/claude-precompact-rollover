import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  contentDigest,
  decideAction,
  inspectEntries,
  mergeConfig,
  profileForModel,
  selectRecentTurns,
  usageTokens,
} from "../src/core.mjs";

const assistant = (tokens, stop = "end_turn", model = "test-200k") => ({
  type: "assistant",
  message: {
    model,
    stop_reason: stop,
    usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 100 },
    content: [{ type: "text", text: "reply" }],
  },
});

describe("threshold state machine", () => {
  const profile = DEFAULT_CONFIG.profiles["200k"];

  test("prepares, warns, and rolls at conservative 200k defaults", () => {
    expect(decideAction({ tokens: 140000, compactCount: 0, idleAfterFinal: true }, profile, {}).action).toBe("prepare");
    expect(decideAction({ tokens: 155000, compactCount: 0, idleAfterFinal: true }, profile, { prepared: true }).action).toBe("warn");
    expect(decideAction({ tokens: 160000, compactCount: 0, idleAfterFinal: true }, profile, { prepared: true, warned: true }).action).toBe("rollover");
  });

  test("waits for a complete reply", () => {
    expect(decideAction({ tokens: 170000, compactCount: 0, idleAfterFinal: false }, profile, {}).action).toBe("wait");
  });

  test("new compaction takes priority over thresholds", () => {
    expect(decideAction({ tokens: 52000, compactCount: 1, idleAfterFinal: true }, profile, {}).action).toBe("rescue");
  });

  test("1m profile disables automatic rollover", () => {
    const config = mergeConfig({ oneMillionModels: ["opus-1m"] });
    const oneMillion = profileForModel("opus-1m", config);
    expect(oneMillion.autoRollover).toBe(false);
    expect(decideAction({ tokens: 900000, compactCount: 0, idleAfterFinal: true }, oneMillion, {}).action).toBe("none");
    expect(decideAction({ tokens: 300000, compactCount: 1, idleAfterFinal: true }, oneMillion, {}).action).toBe("manual_rescue_available");
  });
});

test("usage includes cached prompt tokens", () => {
  expect(usageTokens({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 })).toBe(60);
});

test("transcript inspection sees post-tool compaction and latest model", () => {
  const entries = [assistant(165000, "end_turn"), { type: "system", subtype: "compact_boundary" }, assistant(52000, "end_turn", "after")];
  expect(inspectEntries(entries)).toMatchObject({ tokens: 52000, model: "after", compactCount: 1, idleAfterFinal: true });
});

test("recent-token selection keeps whole turns and anchors", () => {
  const turns = [
    { id: "anchor", user: "old promise", assistant: "remembered" },
    { id: "middle", user: "x".repeat(400), assistant: "y".repeat(400) },
    { id: "latest", user: "latest", assistant: "reply" },
  ];
  const selected = selectRecentTurns(turns, 1, new Set(["anchor"]));
  expect(selected.turns.map(turn => turn.id)).toEqual(["anchor"]);
  const selectedWide = selectRecentTurns(turns, 8, new Set(["anchor"]));
  expect(selectedWide.turns.map(turn => turn.id)).toEqual(["anchor", "latest"]);
  expect(contentDigest(selectedWide.turns)).toHaveLength(64);
});

test("invalid threshold ordering fails closed", () => {
  expect(() => mergeConfig({ profiles: { "200k": { prepareAt: 160000, warnAt: 155000 } } })).toThrow();
});
