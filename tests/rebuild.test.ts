import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const temporaryRoots = [];
afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop(), { recursive: true, force: true });
});
function pair(sessionId, cwd, index, textSize = 20) {
  const userUuid = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const assistantUuid = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return [
    {
      type: "user",
      uuid: userUuid,
      parentUuid: index === 1 ? null : `20000000-0000-4000-8000-${String(index - 1).padStart(12, "0")}`,
      sessionId,
      cwd,
      origin: { kind: "human" },
      promptSource: "typed",
      message: { role: "user", content: `user-${index}-` + "u".repeat(textSize) },
    },
    {
      type: "assistant",
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId,
      cwd,
      message: {
        id: `msg_${index}`,
        type: "message",
        role: "assistant",
        model: "synthetic-200k",
        content: [{ type: "text", text: `assistant-${index}-` + "a".repeat(textSize) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000 * index, output_tokens: 20 },
      },
    },
  ];
}

describe("mechanical rebuild", () => {
  test("keeps whole turns, strips usage, and verifies the target digest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rollover-e2e-"));
    temporaryRoots.push(root);
    const cwd = path.join(root, "project");
    const configDir = path.join(root, "claude-config");
    const runtime = path.join(root, "runtime");
    const sessionId = "30000000-0000-4000-8000-000000000001";
    const projectKey = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const transcriptDir = path.join(configDir, "projects", projectKey);
    const planPath = path.join(root, "context-plan.json");
    await mkdir(cwd, { recursive: true });
    await mkdir(transcriptDir, { recursive: true });
    const entries = [
      ...pair(sessionId, cwd, 1, 3000),
      ...pair(sessionId, cwd, 2, 3000),
      { type: "system", subtype: "compact_boundary", uuid: "40000000-0000-4000-8000-000000000001", sessionId, cwd },
      { type: "user", uuid: "50000000-0000-4000-8000-000000000001", parentUuid: null, sessionId, cwd, isCompactSummary: true, message: { role: "user", content: "automatic compact summary" } },
      ...pair(sessionId, cwd, 3, 20),
    ];
    await writeFile(path.join(transcriptDir, `${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(planPath, JSON.stringify({
      version: 1,
      sourceSessionId: sessionId,
      retainTokens: 1000,
      pinnedMessageIds: ["10000000-0000-4000-8000-000000000001"],
      hiddenMessageIds: ["20000000-0000-4000-8000-000000000003"],
      nextWindow: { model: "synthetic-next", effort: "high" },
    }));

    const child = Bun.spawn([
      process.execPath,
      path.resolve("src/rebuild.ts"),
      sessionId,
      cwd,
      "typed",
      runtime,
    ], {
      cwd: path.resolve("."),
      env: {
        ...Bun.env,
        CLAUDE_CONFIG_DIR: configDir,
        ROLLOVER_RETAIN_TOKENS: "1000",
        ROLLOVER_CONTEXT_PLAN_PATH: planPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(runtime, "candidate-manifest.json"), "utf8"));
    expect(manifest.source_digest).toBe(manifest.target_digest);
    expect(manifest.retained_users).toBeGreaterThan(0);
    expect(manifest.retained_users).toBeLessThanOrEqual(3);
    expect(manifest.stripped_inherited_usage_entries).toBe(manifest.retained_pairs);
    expect(manifest.context_plan_applied).toBe(true);
    expect(manifest.pinned_messages).toBe(1);
    expect(manifest.hidden_messages).toBe(1);
    const rebuilt = await readFile(manifest.transcript_path, "utf8");
    expect(rebuilt).not.toContain("automatic compact summary");
    expect(rebuilt).not.toContain("assistant-1-");
    expect(rebuilt).not.toContain("assistant-3-");
    expect(rebuilt).toContain("context-omitted");
    expect(rebuilt).toContain("user-1-");
    expect(rebuilt).toContain("user-3-");
    const contextManifest = JSON.parse(await readFile(path.join(runtime, "context-manifest.json"), "utf8"));
    expect(contextManifest).toMatchObject({
      strategy: "recent-complete-turns-plus-message-pins",
      hidePrecedence: "hide-wins",
      digestMatch: true,
    });
    expect(contextManifest.pinnedMessageTargets).toHaveLength(1);
  }, 20_000);
});
