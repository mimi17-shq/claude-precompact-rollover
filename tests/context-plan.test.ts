import { describe, expect, test } from "bun:test";
import {
  assertPlanIds,
  normalizeContextPlan,
  selectContextTurns,
  typedTurnsFromEntries,
} from "../src/context-plan.mjs";

const turn = (id, size = 200) => ({
  id: `user-${id}`,
  userId: `user-${id}`,
  assistantId: `assistant-${id}`,
  userContent: `question-${id}-` + "u".repeat(size),
  assistantContent: [{ type: "text", text: `reply-${id}-` + "a".repeat(size) }],
});

describe("context plan contract", () => {
  test("normalizes a session-bound plan", () => {
    expect(normalizeContextPlan({
      version: 1,
      sourceSessionId: "session-1",
      retainTokens: 12000,
      pinnedMessageIds: ["assistant-1"],
      hiddenMessageIds: ["user-2"],
      nextWindow: { model: "next", effort: "high" },
    }, { sourceSessionId: "session-1" })).toMatchObject({
      retainTokens: 12000,
      pinnedMessageIds: ["assistant-1"],
      hiddenMessageIds: ["user-2"],
    });
  });

  test("fails closed for a different session or stale message id", () => {
    expect(() => normalizeContextPlan({ version: 1, sourceSessionId: "wrong" }, {
      sourceSessionId: "session-1",
    })).toThrow("does not match");
    const plan = normalizeContextPlan({
      version: 1,
      sourceSessionId: "session-1",
      pinnedMessageIds: ["missing"],
    });
    expect(() => assertPlanIds(plan, new Set(["user-1"]))).toThrow("missing message ids");
  });

  test("selects an old pinned message while keeping recent selection separate", () => {
    const turns = [turn(1, 5000), turn(2, 5000), turn(3, 5000)];
    const selected = selectContextTurns(turns, {
      retainTokens: 1000,
      pinnedMessageIds: ["assistant-1", "user-2"],
      hiddenMessageIds: ["user-2"],
    });
    expect([...selected.selectedTurnIds]).toContain("user-1");
    expect([...selected.selectedTurnIds]).toContain("user-2");
    expect([...selected.selectedTurnIds]).toContain("user-3");
    expect([...selected.recentTurnIds]).toEqual(["user-3"]);
    expect(selected.hiddenWins).toBe(true);
  });

  test("extracts complete typed turns without exposing tool-only entries", () => {
    const entries = [
      { type: "user", uuid: "u1", parentUuid: null, origin: { kind: "human" }, promptSource: "typed", message: { content: "hello" } },
      { type: "assistant", uuid: "tool", parentUuid: "u1", message: { stop_reason: null, content: [{ type: "tool_use", name: "x" }] } },
      { type: "assistant", uuid: "a1", parentUuid: "tool", message: { stop_reason: "end_turn", content: [{ type: "text", text: "world" }] } },
    ];
    expect(typedTurnsFromEntries(entries)).toEqual([expect.objectContaining({
      id: "u1",
      userId: "u1",
      assistantId: "a1",
    })]);
  });
});
