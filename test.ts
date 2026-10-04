import assert from "node:assert";
import registerAdw, { executeAdwPipeline, detectVerificationCommand } from "./index.ts";

console.log("=== Testing pi-adw extension (Hardened) ===");

const cwd = process.cwd();

// 1. Tool and Command Registration Test
const registeredTools = new Map();
const registeredCommands = new Map();

const mockPi = {
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on() {},
};

registerAdw(mockPi as any);

assert(registeredTools.has("adw"), "adw tool must be registered");
assert(registeredCommands.has("adw"), "/adw command must be registered");
const adwTool = registeredTools.get("adw");
console.log("✓ Tool 'adw' and command '/adw' verified");

// 2. Detection Test
const detectedCmd = detectVerificationCommand(cwd);
console.log("✓ Detected verification command for cwd:", detectedCmd || "none");

// 3. Five-argument tool execute test (pass case)
const mockCtx: any = {
  cwd,
  getContextUsage: () => ({ tokens: 20000, contextWindow: 100000, percent: 20 }),
  compact: () => {},
  ui: { notify: () => {} },
};

const controller = new AbortController();
const toolRes = await adwTool.execute(
  "call-adw-1",
  { goal: "Quick self-check", verifyCommand: 'node -e "process.exit(0)"' },
  controller.signal,
  () => {},
  mockCtx
);
assert(toolRes.content[0].text.includes("AI Developer Workflow"), "Tool execution must output report");
assert(toolRes.content[0].text.includes("PASS"), "Must report PASS for exit 0");
console.log("✓ Pi 5-argument tool.execute contract verified");

// 4. Skipped verification test (must not falsely report PASS)
const skippedRes = await executeAdwPipeline(
  "Check skipped verification",
  { verifyCommand: "" },
  "/tmp",
  mockCtx,
  controller.signal
);
assert.equal(skippedRes.testStatus, "skipped", "Empty verification command must report 'skipped', not 'pass'");
assert(skippedRes.reportMarkdown.includes("SKIPPED"), "Markdown report must state SKIPPED");
console.log("✓ Verification skipped state verified (prevents false-positive test passes)");

console.log("\nALL TESTS PASSED! pi-adw is fully hardened.");

// Regression checks for the verification gate
{
  const { executeAdwPipeline } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  delete process.env.TYPESAFE_API_KEY;
  let compactCalls = 0;
  const hotCtx: any = { compact: () => compactCalls++, getContextUsage: () => ({ tokens: 99000, contextWindow: 100000, percent: 99 }), ui: { notify: () => {} } };
  // never compacts (ctx.compact aborts the run and would discard the report)
  const big = await executeAdwPipeline("g", { verifyCommand: `node -e "process.stdout.write('x'.repeat(3*1024*1024))"` }, process.cwd(), hotCtx);
  assert.equal(compactCalls, 0, "adw must never call ctx.compact");
  assert.equal(big.testStatus, "pass", "3 MB of output must not be a false fail (old 1 MB maxBuffer)");
  const failed = await executeAdwPipeline("g", { verifyCommand: `node -e "console.error('boom'); process.exit(3)"` }, process.cwd(), hotCtx);
  assert.equal(failed.testStatus, "fail");
  assert.match(failed.reportMarkdown, /boom/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const aborted = await executeAdwPipeline("g", { verifyCommand: `node -e "setTimeout(()=>{}, 10000)"` }, process.cwd(), hotCtx, ac.signal);
  assert.equal(aborted.testStatus, "fail", "aborted verification must not report pass");
  console.log("✓ no compaction, 3 MB output passes, failure + abort reported as fail");
}

// Process control: TERM-ignoring command must not pass after timeout; descendants die on abort
{
  const { executeAdwPipeline } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  const cp = await import("node:child_process");
  const pg = (pat: string) => { try { return cp.execFileSync("pgrep", ["-f", pat], { encoding: "utf8" }).trim(); } catch { return ""; } };
  const { runBounded } = await import("./index.ts");
  const t0 = Date.now();
  const stubborn = await runBounded("trap '' TERM; sleep 3.7", { cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(stubborn.timedOut, true);
  assert.ok(Date.now() - t0 < 3000, "killed by SIGKILL escalation, not left to finish");
  assert.equal(pg("sleep 3.7"), "", "no straggler after timeout");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const hot: any = { getContextUsage: () => undefined, ui: { notify: () => {} } };
  const ab = await executeAdwPipeline("g", { verifyCommand: "sleep 6.1 & sleep 6.2; wait" }, process.cwd(), hot, ac.signal);
  assert.equal(ab.testStatus, "fail");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pg("sleep 6.1") + pg("sleep 6.2"), "", "abort kills background descendants too");
  console.log("✓ TERM-ignoring command times out (never passes), abort kills the process group");
}

// A setsid escapee holding the pipes must not hang verification (final re-review)
{
  const { runBounded } = await import("./index.ts");
  const assert = (await import("node:assert")).default;
  const cp = await import("node:child_process");
  const t0 = Date.now();
  const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
  const pidf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adw-esc-")), "pid");
  const esc = `python3 -c 'import os,sys,time; os.setsid(); open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(8.8)' '${pidf}' & true`;
  const killEscapee = () => { try { process.kill(Number(fs.readFileSync(pidf, "utf8")), "SIGKILL"); } catch {} }; // exact PID only
  const r = await runBounded(esc, { cwd: process.cwd(), timeoutMs: 200 });
  const took = Date.now() - t0;
  killEscapee();
  // the same escape on ABORT must be reported too, not just on timeout
  const { executeAdwPipeline } = await import("./index.ts");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const ab = await executeAdwPipeline("g", { verifyCommand: esc + "; sleep 9.1" }, process.cwd(), { getContextUsage: () => undefined, ui: { notify: () => {} } } as any, ac.signal);
  killEscapee();
  assert.equal(ab.testStatus, "fail");
  assert.match(ab.reportMarkdown, /Aborted \(process group killed; a descendant escaped the group/, ab.reportMarkdown);
  assert.ok(took < 6500, `must settle despite an escaped pipe holder (${took} ms)`);
  assert.ok(r.timedOut && r.escaped);
  console.log("✓ setsid escapee: verification settles and reports the escape");
}

// A command that exits but leaves a background child with closed pipes: the child is killed and reported
{
  const { runBounded } = await import("./index.ts");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pidf = join(mkdtempSync(join(tmpdir(), "adw-stray-")), "child.pid");
  const r = await runBounded(`python3 -c 'import os,sys,time; open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(27.7)' '${pidf}' >/dev/null 2>&1 & sleep 0.3; true`, { cwd: tmpdir(), timeoutMs: 10000 });
  const pid = Number(readFileSync(pidf, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) process.kill(pid, "SIGKILL");
  assert.ok(!alive && r.strays && r.code === 0 && !r.timedOut, JSON.stringify({ alive, ...r }));
  console.log("✓ closed-pipe background child: killed, reported as strays");
}

// ---- review 3 regressions. The runBounded block is run in a vm against a mocked OS, so cancellation and
// recycled process-group ids can be staged deterministically without touching a real process.
{
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname, resolve } = await import("node:path");
  const vm = await import("node:vm");
  const { EventEmitter } = await import("node:events");
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const from = src.indexOf("export interface BoundedResult");
  const procs = src.indexOf("// Processes (any session");
  const end = procs > 0 ? procs : src.indexOf("\n", src.indexOf("const groupAlive"));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(src.slice(from, end)).replaceAll("export ", "");
  const LEADER = 424242;
  const esrch = () => { const e: any = new Error("ESRCH"); e.code = "ESRCH"; return e; };
  // sandbox: sent = non-zero signals, spawned = spawn() calls; hooks let a case script the OS
  const sandbox = (over: any = {}) => {
    const box: any = { console, Buffer, setTimeout, clearTimeout, join, dirname, resolvePath: resolve, readFileSync, realpathSync, sent: [] as any[], spawned: 0, ps: "", ...over };
    box.process = { platform: "darwin", env: {}, kill: (pid: number, sig: any) => { if (sig === 0) { if (box.alive?.(pid)) return true; throw esrch(); } box.sent.push([pid, sig]); box.onSignal?.(pid, sig); return true; }, ...over.process };
    box.execFile = () => { throw new Error("unexpected taskkill"); };
    box.execFileSync = (_c: string, args: string[]) => (args.includes("-axo") ? box.ps : box.leaderPs ?? "");
    box.spawn ??= () => { box.spawned++; const c: any = new EventEmitter(); c.pid = LEADER; c.exitCode = null; c.signalCode = null; c.stdout = Object.assign(new EventEmitter(), { destroy() {} }); c.stderr = Object.assign(new EventEmitter(), { destroy() {} }); box.child = c; setImmediate(() => box.script?.(c)); return c; };
    vm.createContext(box);
    vm.runInContext(code, box);
    return box;
  };
  const opts = (signal?: AbortSignal) => ({ cwd: tmpdir(), timeoutMs: 20000, signal });

  // 1. an already-aborted signal never starts the command (POSIX and Windows), nor does one aborted while the shell resolves
  {
    const box = sandbox();
    const r = await box.runBounded("echo REVIEW3_PREABORT", opts(AbortSignal.abort()));
    assert.equal(box.spawned, 0, "pre-aborted: spawn must not happen");
    assert.ok(r.aborted && r.code === null && r.out === "", JSON.stringify(r));
    const w = sandbox({ process: { platform: "win32" }, spawn: () => { w.spawned++; throw new Error("must not spawn"); } });
    const w2 = await w.runBounded("echo REVIEW3_PREABORT", opts(AbortSignal.abort()));
    assert.equal(w.spawned, 0);
    assert.ok(w2.aborted && w2.code === null, JSON.stringify(w2));
    // abort lands while winShell() is awaited
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w3 = sandbox({ process: { platform: "win32" }, gate, spawn: () => { w3.spawned++; throw new Error("must not spawn"); } });
    vm.runInContext('winShell = async () => { await gate; return "sh"; };', w3);
    const ac = new AbortController();
    const pending = w3.runBounded("echo REVIEW3_PREABORT", opts(ac.signal));
    ac.abort();
    release();
    const r3 = await pending;
    assert.equal(w3.spawned, 0, "aborted during shell resolution: spawn must not happen");
    assert.ok(r3.aborted && r3.code === null, JSON.stringify(r3));
    console.log("✓ already-aborted / aborted-while-resolving: not spawned, reported aborted");
  }

  // 2a. a recycled group (leader pid gone, replacement members alive, none of them ours) is never signalled
  {
    const box = sandbox({ alive: (pid: number) => pid === -LEADER, script: (c: any) => { c.exitCode = 0; c.emit("close", 0); } });
    const r = await box.runBounded("true", opts());
    assert.deepEqual(box.sent, [], "foreign group must get no signal");
    assert.ok(r.foreign && !r.strays, JSON.stringify(r));
    console.log("✓ unproven (recycled) group: no signal, reported foreign");
  }

  // 2b. ownership is re-proven before EACH signal: our stray proves the group for TERM, then the group is recycled
  for (const recycle of [false, true]) {
    const box = sandbox({
      alive: (pid: number) => pid === -LEADER,
      ps: `${LEADER} ${LEADER}\n777 ${LEADER}\n`,
      script: (c: any) => { c.exitCode = 0; c.emit("exit", 0); c.emit("close", 0); if (recycle) setTimeout(() => { box.ps = `900 ${LEADER}\n`; }, 250); },
    });
    const r = await box.runBounded("true", opts());
    if (recycle) {
      assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"]], "KILL must not follow once the group is no longer provably ours");
      assert.ok(r.foreign && r.strays, JSON.stringify(r));
    } else {
      assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"], [-LEADER, "SIGKILL"]]);
      assert.ok(r.strays && !r.foreign, JSON.stringify(r));
    }
  }
  console.log("✓ stray group: signalled while provably ours, left alone once recycled");

  // 3. winShell follows Pi's effective settings: trusted project settings override the global shellPath
  {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-")));
    const agent = join(base, "agent"), proj = join(base, "proj");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: "/bin/sh" }));
    writeFileSync(join(proj, ".pi", "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
    const { winShell } = await import("./index.ts");
    const [cwd0, env0] = [process.cwd(), process.env.PI_CODING_AGENT_DIR];
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(proj);
    try {
      writeFileSync(join(agent, "trust.json"), JSON.stringify({}));
      assert.equal(await winShell(), "/bin/sh", "untrusted project: its settings are ignored");
      writeFileSync(join(agent, "trust.json"), JSON.stringify({ [dirname(proj)]: true }));
      assert.equal(await winShell(), "/bin/bash", "trusted (ancestor entry): project shellPath wins, as in Pi");
      writeFileSync(join(agent, "trust.json"), JSON.stringify({ [dirname(proj)]: true, [proj]: false }));
      assert.equal(await winShell(), "/bin/sh", "nearest trust entry is false");
    } finally {
      process.chdir(cwd0);
      if (env0 === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env0;
      rmSync(base, { recursive: true, force: true });
    }
    console.log("✓ winShell: Pi's merged settings, project trust respected");
  }

  // 4. (race only) killGroup re-proves ownership before each signal
  if (typeof (sandbox() as any).killGroup === "function") {
    for (const recycle of [false, true]) {
      const box = sandbox({
        alive: (pid: number) => (pid === -LEADER || (pid === LEADER && !box.replaced)) && !box.dead,
        leaderPs: "S bash race-leader /m/marker\n",
        ps: `${LEADER} ${LEADER}\n555 ${LEADER}\n`,
        onSignal: (_p: number, sig: string) => { if (sig === "SIGTERM") { box.replaced = true; box.ps = recycle ? `900 ${LEADER}\n` : `555 ${LEADER}\n`; box.leaderPs = "S unrelated\n"; } else box.dead = true; },
      });
      const out = await box.killGroup(LEADER, "/m/marker");
      if (recycle) {
        assert.equal(out, "foreign");
        assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"]], "no KILL to a group that is no longer provably ours");
      } else {
        assert.equal(out, "killed");
        assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"], [-LEADER, "SIGKILL"]]);
      }
    }
    console.log("✓ killGroup: ownership re-proven before every signal");
  }
}

// 4. a PASS verdict still carries the cleanup warning (it used to be dropped unless the run failed)
{
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "adw-report-"));
  const pidf = join(dir, "child.pid");
  const r = await executeAdwPipeline("stray report", { verifyCommand: `python3 -c 'import os,sys,time; open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(24.7)' '${pidf}' >/dev/null 2>&1 & sleep 0.3; true` }, dir);
  const pid = Number(readFileSync(pidf, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) process.kill(pid, "SIGKILL");
  assert.equal(r.testStatus, "pass");
  assert.ok(!alive, "stray killed");
  assert.match(r.reportMarkdown, /Cleanup:\*\* the verify command left background processes/, r.reportMarkdown);
  console.log("✓ PASS report keeps the stray-process warning");
}
