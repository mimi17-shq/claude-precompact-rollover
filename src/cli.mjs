#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import {
  assertPlanIds,
  normalizeContextPlan,
  selectContextTurns,
  turnMessageIds,
  typedTurnsFromEntries,
} from "./context-plan.mjs";
import { decideAction, inspectEntries, parseJsonl, profileForModel } from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = rest[index + 1];
    options[key] = next && !next.startsWith("--") ? rest[++index] : true;
  }
  return { command, options };
}

async function atomicPrivate(pathname, value) {
  await mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, pathname);
}

async function inspectTranscript(pathname) {
  const parsed = parseJsonl(await readFile(pathname, "utf8"));
  if (parsed.invalidLines.length) throw new Error(`invalid JSONL lines: ${parsed.invalidLines.join(",")}`);
  return inspectEntries(parsed.entries);
}

async function loadPlan(pathname, sourceSessionId) {
  if (!pathname) return null;
  const parsed = JSON.parse(await readFile(path.resolve(pathname), "utf8"));
  return normalizeContextPlan(parsed, { sourceSessionId });
}

async function runRebuild(options, config) {
  if (!options.session) throw new Error("--session is required");
  const cwd = path.resolve(options.cwd || process.cwd());
  const runtime = path.resolve(options.runtime || path.join(cwd, ".claude-rollover"));
  const plan = await loadPlan(options.plan, options.session);
  const retainTokens = Number(options.retainTokens || plan?.retainTokens || config.retainTokens);
  const nextModel = String(options.model || plan?.nextWindow.model || config.nextWindow.model || "");
  const nextEffort = String(options.effort || plan?.nextWindow.effort || config.nextWindow.effort || "");
  if (options.transcript) {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const backup = path.join(runtime, `source-before-rollover-${Date.now()}.jsonl`);
    await copyFile(path.resolve(options.transcript), backup);
    await chmod(backup, 0o600);
  }
  const executable = process.env.ROLLOVER_BUN || "bun";
  const child = spawn(executable, [path.join(here, "rebuild.ts"), options.session, cwd, options.sourceMode || "typed", runtime], {
    stdio: "inherit",
    env: {
      ...process.env,
      ROLLOVER_RETAIN_TOKENS: String(retainTokens),
      ROLLOVER_NEXT_MODEL: nextModel,
      ROLLOVER_NEXT_EFFORT: nextEffort,
      ROLLOVER_CONTEXT_PLAN_PATH: options.plan ? path.resolve(options.plan) : "",
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", value => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`rebuild exited with status ${code}`);
  const manifest = JSON.parse(await readFile(path.join(runtime, "candidate-manifest.json"), "utf8"));
  const launch = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceSessionId: options.session,
    targetSessionId: manifest.target_session_id,
    model: nextModel || null,
    effort: nextEffort || null,
    retainTokens,
    digestMatch: manifest.source_digest === manifest.target_digest,
  };
  await atomicPrivate(path.join(runtime, "next-window.json"), `${JSON.stringify(launch, null, 2)}\n`);
  return launch;
}

function help() {
  return `claude-precompact-rollover

Commands:
  status  --transcript FILE [--config FILE] [--state FILE]
  watch   --transcript FILE --session ID [--cwd DIR] [--config FILE] [--plan FILE]
  preview --transcript FILE --session ID --plan FILE
  rebuild --session ID [--cwd DIR] [--plan FILE] [--retain-tokens N] [--model NAME] [--effort LEVEL]
  hook    [--config FILE] [--state FILE]   Read Claude hook JSON from stdin

The tool never terminates or restarts Claude by itself. A successful rebuild writes
next-window.json with the verified target session and requested launch settings.`;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function watch(options, config) {
  if (!options.transcript || !options.session) throw new Error("watch requires --transcript and --session");
  const transcript = path.resolve(options.transcript);
  const statePath = path.resolve(options.state || path.join(options.cwd || process.cwd(), ".claude-rollover", "state.json"));
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let lastIdentity = "";
  let stableSince = Date.now();
  for (;;) {
    const info = await stat(transcript);
    const identity = `${info.size}:${info.mtimeMs}`;
    if (identity !== lastIdentity) {
      lastIdentity = identity;
      stableSince = Date.now();
    }
    const snapshot = await inspectTranscript(transcript);
    const profile = profileForModel(options.model || snapshot.model, config);
    const decision = decideAction(snapshot, profile, state);
    if (decision.action === "prepare" || decision.action === "warn") {
      if (decision.action === "prepare") state.prepared = true;
      if (decision.action === "warn") state.warned = true;
      console.error(JSON.stringify({ event: decision.action, message: config.prepare.message, tokens: snapshot.tokens }));
    }
    const stable = Date.now() - stableSince >= Number(config.stableSeconds) * 1000;
    if ((decision.action === "rollover" || decision.action === "rescue") && snapshot.idleAfterFinal && stable) {
      const launch = await runRebuild({ ...options, transcript }, config);
      state.readyTargetSessionId = launch.targetSessionId;
      state.handledCompactCount = snapshot.compactCount;
      state.completedAt = new Date().toISOString();
      await atomicPrivate(statePath, `${JSON.stringify({ ...state, lastSnapshot: snapshot }, null, 2)}\n`);
      console.log(JSON.stringify({ event: "ready", decision, launch }, null, 2));
      return;
    }
    await atomicPrivate(statePath, `${JSON.stringify({ ...state, lastSnapshot: snapshot }, null, 2)}\n`);
    await delay(Number(config.pollSeconds) * 1000);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || options.help) {
    console.log(help());
    return;
  }
  const config = await loadConfig(options.config);
  if (command === "rebuild") {
    console.log(JSON.stringify(await runRebuild(options, config), null, 2));
    return;
  }
  if (command === "preview") {
    if (!options.transcript || !options.session || !options.plan) {
      throw new Error("preview requires --transcript, --session, and --plan");
    }
    const parsed = parseJsonl(await readFile(path.resolve(options.transcript), "utf8"));
    if (parsed.invalidLines.length) throw new Error(`invalid JSONL lines: ${parsed.invalidLines.join(",")}`);
    const plan = await loadPlan(options.plan, options.session);
    const deliveryToolNames = new Set(String(process.env.ROLLOVER_DELIVERY_TOOLS || "")
      .split(",").map(value => value.trim()).filter(Boolean));
    const turns = typedTurnsFromEntries(parsed.entries, { deliveryToolNames });
    const available = new Set(turns.flatMap(turnMessageIds));
    const idCheck = assertPlanIds(plan, available);
    const retainTokens = Number(options.retainTokens || plan.retainTokens || config.retainTokens);
    const selection = selectContextTurns(turns, {
      retainTokens,
      pinnedMessageIds: plan.pinnedMessageIds,
      hiddenMessageIds: plan.hiddenMessageIds,
    });
    const retained = turns.filter(turn => selection.selectedTurnIds.has(turn.id));
    console.log(JSON.stringify({
      version: 1,
      sourceSessionId: options.session,
      strategy: "recent-complete-turns-plus-message-pins",
      hidePrecedence: "hide-wins",
      retainTokens,
      sourceTurns: turns.length,
      retainedTurns: retained.length,
      retainedMessages: retained.length * 2,
      pinnedMessages: plan.pinnedMessageIds.length,
      hiddenMessages: plan.hiddenMessageIds.length,
      pinHideConflicts: idCheck.pinHideConflicts,
      estimatedRetainedTokens: selection.estimatedTokens,
      retainedTurnIds: retained.map(turn => turn.id),
    }, null, 2));
    return;
  }
  if (command === "watch") {
    await watch(options, config);
    return;
  }

  let hook = null;
  if (command === "hook") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    hook = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    options.transcript = options.transcript || hook.transcript_path;
    options.session = options.session || hook.session_id;
    options.cwd = options.cwd || hook.cwd;
  }
  if (command !== "status" && command !== "hook") throw new Error(`unknown command: ${command}`);
  if (!options.transcript) throw new Error("--transcript is required");

  const snapshot = await inspectTranscript(path.resolve(options.transcript));
  const profile = profileForModel(options.model || snapshot.model, config);
  const statePath = path.resolve(options.state || path.join(options.cwd || process.cwd(), ".claude-rollover", "state.json"));
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (hook?.hook_event_name === "PreCompact" && snapshot.compactCount === (state.handledCompactCount || 0)) {
    state.preCompactObservedAt = new Date().toISOString();
  }
  const decision = decideAction(snapshot, profile, state);
  if (decision.action === "prepare") state.prepared = true;
  if (decision.action === "warn") state.warned = true;
  await atomicPrivate(statePath, `${JSON.stringify({ ...state, lastSnapshot: snapshot }, null, 2)}\n`);
  console.log(JSON.stringify({ snapshot, profile, decision, retainTokens: config.retainTokens, nextWindow: config.nextWindow }, null, 2));
}

main().catch(error => {
  console.error(`claude-precompact-rollover: ${error?.message || error}`);
  process.exitCode = 1;
});
