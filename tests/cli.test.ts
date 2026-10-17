import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const temporaryRoots = [];
afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop(), { recursive: true, force: true });
});

test("preview returns selection metadata without conversation text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rollover-preview-"));
  temporaryRoots.push(root);
  const transcript = path.join(root, "session.jsonl");
  const plan = path.join(root, "context-plan.json");
  await writeFile(transcript, [
    {
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      origin: { kind: "human" },
      promptSource: "typed",
      message: { content: "private user text" },
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      parentUuid: "user-1",
      message: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "private assistant text" }],
      },
    },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(plan, JSON.stringify({
    version: 1,
    sourceSessionId: "session-1",
    retainTokens: 1000,
    pinnedMessageIds: ["assistant-1"],
    hiddenMessageIds: [],
  }));

  const child = Bun.spawn([
    process.execPath,
    path.resolve("src/cli.mjs"),
    "preview",
    "--session", "session-1",
    "--transcript", transcript,
    "--plan", plan,
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("private user text");
  expect(stdout).not.toContain("private assistant text");
  expect(JSON.parse(stdout)).toMatchObject({
    strategy: "recent-complete-turns-plus-message-pins",
    retainedTurns: 1,
    pinnedMessages: 1,
  });
});
