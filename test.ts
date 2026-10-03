import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import registerAdw, { executeAdwPipeline, detectVerificationCommand } from "./index.ts";

console.log("=== Testing pi-adw extension ===");

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
assert.equal(adwTool.name, "adw");
assert(adwTool.parameters.properties.goal, "tool must accept goal parameter");
console.log("✓ Tool 'adw' and command '/adw' verified");

// 2. Detection Test
const detectedCmd = detectVerificationCommand(cwd);
console.log("✓ Detected verification command for cwd:", detectedCmd || "none (fallback allowed)");

// 3. Pipeline Execution Test
console.log("Running executeAdwPipeline...");
const mockContext: any = {
  cwd,
  getContextUsage: () => ({ tokens: 20000, contextWindow: 100000, percent: 20 }),
  compact: () => {},
  ui: { notify: () => {} },
};

const result = await executeAdwPipeline(
  "Test ADW pipeline execution",
  { verifyCommand: 'node -e "process.exit(0)"', autoCompactAtPct: 80 },
  cwd,
  mockContext
);

assert(result.goal, "Result must contain goal");
assert(result.testPassed, "Verification test must pass");
assert(result.reportMarkdown.includes("AI Developer Workflow"), "Report markdown must contain ADW header");
assert(result.reportMarkdown.includes("Verification"), "Report markdown must contain verification section");
console.log("✓ ADW pipeline executed cleanly:");
console.log("  - Scope:", result.scopeSize);
console.log("  - Risk level:", Math.round(result.riskLevel * 100) + "%");
console.log("  - Verification:", result.testPassed ? "PASS" : "FAIL");
if (result.jevReadiness !== undefined) {
  console.log("  - Jev readiness:", Math.round(result.jevReadiness * 100) + "%");
}

// 4. Tool Execution Test
const toolRes = await adwTool.execute("call-adw-1", { goal: "Quick self-check", verifyCommand: 'node -e "process.exit(0)"' }, mockContext);
assert(toolRes.content[0].text.includes("AI Developer Workflow"), "Tool execution must output report");
console.log("✓ adw tool execution verified");

console.log("\nALL TESTS PASSED! pi-adw is fully verified.");
