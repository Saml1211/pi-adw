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
