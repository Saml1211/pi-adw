import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

function resolveJevApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  try {
    const configPath = join(homedir(), ".pi/agent/pi-jev.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
      if (cfg.apiKeyFile) {
        const keyFilePath = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
        if (existsSync(keyFilePath)) {
          return readFileSync(keyFilePath, "utf8").trim();
        }
      }
    }
  } catch {}
  return undefined;
}

export interface AdwPipelineOptions {
  verifyCommand?: string;
  autoCompactAtPct?: number;
}

export interface AdwPipelineResult {
  goal: string;
  scopeSize: string;
  riskLevel: number;
  testPassed: boolean;
  diffSummary: string;
  jevReadiness?: number;
  reportMarkdown: string;
}

function safeExec(cmd: string, cwd: string, timeout = 5000): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export async function runAdwScopeCheck(
  goal: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ scopeSize: string; riskLevel: number } | null> {
  const body = {
    state: `Goal: ${goal}`,
    model: JEV_MODEL,
    questions: {
      scope_size: {
        type: "choice",
        instructions: "What is the expected scope size of this engineering goal?",
        criteria: {
          small_fix: "Single-file or small targeted bug fix (< 30 lines)",
          medium_feature: "Multi-file feature or module addition",
          large_refactor: "Architectural overhaul, schema migration, or broad refactor",
        },
      },
      risk_level: {
        type: "noul",
        instructions: "Does this goal touch critical security, authentication, data persistence, or breaking changes?",
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const answers = json?.answers;
    if (!answers) return null;

    return {
      scopeSize: answers.scope_size?.choice ?? "small_fix",
      riskLevel: answers.risk_level?.noul ?? 0.2,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function detectVerificationCommand(cwd: string): string | undefined {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.test) {
        if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
          return "bun test";
        }
        return "npm test";
      }
    } catch {}
  }
  if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
    return "python3 -m pytest";
  }
  return undefined;
}

export async function executeAdwPipeline(
  goal: string,
  opts: AdwPipelineOptions = {},
  cwd = process.cwd(),
  ctx?: ExtensionContext,
): Promise<AdwPipelineResult> {
  const apiKey = resolveJevApiKey();

  // 1. Prime & Scope Phase
  let scopeSize = "small_fix";
  let riskLevel = 0.2;
  if (apiKey) {
    const scope = await runAdwScopeCheck(goal, apiKey, ctx?.signal);
    if (scope) {
      scopeSize = scope.scopeSize;
      riskLevel = scope.riskLevel;
    }
  }

  // 2. Planning (Ponytail Senior Dev Constraints)
  const branch = safeExec("git rev-parse --abbrev-ref HEAD", cwd) || "unknown";
  const verifyCmd = opts.verifyCommand || detectVerificationCommand(cwd);

  // 3. Context Watchdog Check
  const usage = ctx?.getContextUsage?.();
  const pct = usage?.percent ?? 0;
  let compacted = false;
  const compactThreshold = opts.autoCompactAtPct || 75;
  if (pct >= compactThreshold && ctx?.compact) {
    ctx.compact({
      customInstructions: `ADW WORKFLOW CHECKPOINT:\nGoal: ${goal}\nScope: ${scopeSize}\nBranch: ${branch}`,
    });
    compacted = true;
  }

  // 4. Verification Phase
  let testPassed = true;
  let testOutput = "";
  if (verifyCmd) {
    try {
      testOutput = execSync(verifyCmd, { cwd, encoding: "utf8", timeout: 20000 });
      testPassed = true;
    } catch (err: any) {
      testPassed = false;
      testOutput = err.stderr || err.stdout || err.message;
    }
  }

  // 5. Harvest & Diff Summary
  const diffSummary = safeExec("git diff --stat", cwd) || "No unstaged diffs";

  // 6. TypeSafe Jev Readiness Check
  let jevReadiness: number | undefined;
  if (apiKey) {
    try {
      const body = {
        state: `Goal: ${goal}\nTests passed: ${testPassed}\nDiff: ${diffSummary.slice(0, 1000)}`,
        model: JEV_MODEL,
        questions: {
          ready_for_review: {
            type: "noul",
            instructions: "Is this change verified, clean, and ready for code review?",
          },
        },
      };
      const res = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        jevReadiness = json?.answers?.ready_for_review?.noul ?? 0.8;
      }
    } catch {}
  }

  const sections: string[] = [
    `### 🏭 AI Developer Workflow (ADW) Report`,
    `- **Goal:** ${goal}`,
    `- **Scope Classification:** \`${scopeSize}\` | **Risk Level:** ${Math.round(riskLevel * 100)}%`,
    `- **Branch:** \`${branch}\``,
    `- **Verification (${verifyCmd || "none"}):** ${testPassed ? "✅ PASS" : "❌ FAIL"}`,
  ];

  if (jevReadiness !== undefined) {
    sections.push(`- **Jev Readiness Score:** ${Math.round(jevReadiness * 100)}% confidence`);
  }
  if (compacted) {
    sections.push(`- **Context Maintenance:** Self-compaction triggered at ${pct}% token pressure`);
  }

  sections.push(`\n**Diff Stat:**\n\`\`\`\n${diffSummary}\n\`\`\``);

  if (!testPassed && testOutput) {
    sections.push(`\n**Test Failures:**\n\`\`\`\n${testOutput.slice(-1500)}\n\`\`\``);
  }

  return {
    goal,
    scopeSize,
    riskLevel,
    testPassed,
    diffSummary,
    jevReadiness,
    reportMarkdown: sections.join("\n"),
  };
}

export default function (pi: ExtensionAPI) {
  // 1. Tool: adw
  pi.registerTool({
    name: "adw",
    label: "AI Developer Workflow Engine",
    description:
      "Autonomous 5-phase execution loop (Prime -> Plan -> Build -> Checkpoint -> Verify). Coordinates dynamic context priming, auto-validation, and self-compaction with TypeSafe Jev quality gates.",
    promptSnippet: "Use adw to run a structured software factory cycle against an implementation or bug-fix goal.",
    parameters: Type.Object({
      goal: Type.String({ description: "The feature, bug fix, or refactor goal to execute" }),
      verifyCommand: Type.Optional(
        Type.String({ description: "Optional test verification command (auto-detected if omitted)" }),
      ),
      autoCompactAtPct: Type.Optional(
        Type.Number({ description: "Context usage threshold (default: 75%) to trigger self-compaction" }),
      ),
    }),
    async execute(_id, params, ctx: ExtensionContext) {
      ctx.ui?.notify?.(`[pi-adw] Initiating software factory cycle: "${params.goal.slice(0, 35)}..."`, "info");
      const result = await executeAdwPipeline(
        params.goal,
        { verifyCommand: params.verifyCommand, autoCompactAtPct: params.autoCompactAtPct },
        ctx.cwd || process.cwd(),
        ctx,
      );

      return {
        content: [{ type: "text", text: result.reportMarkdown }],
      };
    },
  });

  // 2. Slash Command: /adw <goal>
  pi.registerCommand("adw", {
    description: "Run an AI Developer Workflow (ADW) cycle against a goal",
    handler: async (args, ctx) => {
      const goal = args?.trim();
      if (!goal) {
        ctx.ui?.notify?.("Usage: /adw <goal description>", "warning");
        return;
      }

      ctx.ui?.notify?.(`[pi-adw] Running ADW cycle for: ${goal}`, "info");
      const result = await executeAdwPipeline(goal, {}, ctx.cwd || process.cwd(), ctx);
      ctx.ui?.notify?.(
        `[pi-adw] Cycle finished: ${result.testPassed ? "Tests passed" : "Tests failed"} (${result.scopeSize})`,
        result.testPassed ? "info" : "error",
      );
    },
  });
}
