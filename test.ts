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
