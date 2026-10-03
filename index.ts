import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const execAsync = promisify(exec);
const VERIFY_TIMEOUT_MS = Number(process.env.PI_ADW_VERIFY_TIMEOUT_MS) > 0 ? Number(process.env.PI_ADW_VERIFY_TIMEOUT_MS) : 300_000;

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
}

export interface AdwPipelineResult {
  goal: string;
  scopeSize: string;
  riskLevel: number;
  testStatus: "pass" | "fail" | "skipped";
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

    const allowedScopes = ["small_fix", "medium_feature", "large_refactor"];
    const scopeRaw = answers.scope_size?.choice;
    const scopeSize = allowedScopes.includes(scopeRaw) ? scopeRaw : "small_fix";

    const riskRaw = answers.risk_level?.noul;
    const riskLevel = typeof riskRaw === "number" && Number.isFinite(riskRaw) ? riskRaw : 0.2;

    return { scopeSize, riskLevel };
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
          return "bun run test";
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
  signal?: AbortSignal,
): Promise<AdwPipelineResult> {
  const apiKey = resolveJevApiKey();
  const effectiveSignal = signal || ctx?.signal;

  // 1. Prime & Scope Phase
  let scopeSize = "small_fix";
  let riskLevel = 0.2;
  if (apiKey) {
    const scope = await runAdwScopeCheck(goal, apiKey, effectiveSignal);
    if (scope) {
      scopeSize = scope.scopeSize;
      riskLevel = scope.riskLevel;
    }
  }

  // 2. Planning (Ponytail Senior Dev Constraints)
  const branch = safeExec("git branch --show-current || git rev-parse --abbrev-ref HEAD", cwd) || "unknown";
  const verifyCmd = opts.verifyCommand || detectVerificationCommand(cwd);

  // No compaction here: ctx.compact() aborts the running agent, which would discard this
  // tool's report and stall the run. Context management belongs to self-compact.

  // 3. Verification (pass | fail | skipped). verifyCmd is a shell command string by design
  // ("npm test", "cargo test"), the same trust level as the agent's own bash tool.
  let testStatus: "pass" | "fail" | "skipped" = "skipped";
  let testOutput = "";
  if (verifyCmd) {
    try {
      // async so a long suite does not freeze Pi's event loop/UI; 10 MB so verbose output is not a false fail
      const { stdout } = await execAsync(verifyCmd, { cwd, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, signal: effectiveSignal });
      testOutput = stdout;
      testStatus = "pass";
    } catch (err: any) {
      testStatus = "fail";
      testOutput = err.killed ? `Timed out or aborted after ${VERIFY_TIMEOUT_MS / 1000}s\n${err.stdout ?? ""}` : err.stderr || err.stdout || err.message;
    }
  }

  // 5. Harvest & Diff Summary (both staged and unstaged)
  const unstaged = safeExec("git diff --stat", cwd);
  const staged = safeExec("git diff --cached --stat", cwd);
  const diffParts: string[] = [];
  if (staged) diffParts.push(`Staged:\n${staged}`);
  if (unstaged) diffParts.push(`Unstaged:\n${unstaged}`);
  const diffSummary = diffParts.join("\n\n") || "No git changes detected";

  // 6. TypeSafe Jev Readiness Check
  let jevReadiness: number | undefined;
  if (apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const body = {
        state: `Goal: ${goal}\nVerification: ${testStatus}\nDiff: ${diffSummary.slice(0, 1000)}`,
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
        signal: effectiveSignal ? AbortSignal.any([controller.signal, effectiveSignal]) : controller.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const noul = json?.answers?.ready_for_review?.noul;
        if (typeof noul === "number" && Number.isFinite(noul)) {
          jevReadiness = noul;
        }
      }
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }

  const statusLabel =
    testStatus === "pass"
      ? "✅ PASS"
      : testStatus === "fail"
      ? "❌ FAIL"
      : "⚠️ SKIPPED (No test runner detected)";

  const sections: string[] = [
    `### 🏭 AI Developer Workflow (ADW) Report`,
    `- **Goal:** ${goal}`,
    `- **Scope Classification:** \`${scopeSize}\` | **Risk Level:** ${Math.round(riskLevel * 100)}%`,
    `- **Branch:** \`${branch}\``,
    `- **Verification (${verifyCmd || "none"}):** ${statusLabel}`,
  ];

  if (jevReadiness !== undefined) {
    sections.push(`- **Jev Readiness Score:** ${Math.round(jevReadiness * 100)}% confidence`);
  }

  sections.push(`\n**Diff Stat:**\n\`\`\`\n${diffSummary}\n\`\`\``);

  if (testStatus === "fail" && testOutput) {
    sections.push(`\n**Test Failures:**\n\`\`\`\n${testOutput.slice(-1500)}\n\`\`\``);
  }

  return {
    goal,
    scopeSize,
    riskLevel,
    testStatus,
    diffSummary,
    jevReadiness,
    reportMarkdown: sections.join("\n"),
  };
}

export default function (pi: ExtensionAPI) {
  // 1. Tool: adw (conforming to Pi's 5-argument execute signature)
  pi.registerTool({
    name: "adw",
    label: "ADW Verification Gate",
    description:
      "Preflight/verification gate for a goal: TypeSafe Jev scope & risk classification, runs the verify command (auto-detected from package.json / Cargo.toml / pytest if omitted), reports staged+unstaged diff stat and a Jev review-readiness score. It does not plan or edit code.",
    promptSnippet: "Use adw before declaring a goal done: it runs the tests and scores review readiness.",
    parameters: Type.Object({
      goal: Type.String({ description: "The feature, bug fix, or refactor goal to execute" }),
      verifyCommand: Type.Optional(
        Type.String({ description: "Optional test verification command (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const effectiveCtx: ExtensionContext | undefined = ctx || (signal && (signal as any).cwd ? (signal as any) : undefined);
      const effectiveSignal: AbortSignal | undefined = signal instanceof AbortSignal ? signal : effectiveCtx?.signal;

      effectiveCtx?.ui?.notify?.(`[pi-adw] Initiating software factory cycle: "${params.goal.slice(0, 35)}..."`, "info");
      const result = await executeAdwPipeline(
        params.goal,
        { verifyCommand: params.verifyCommand },
        effectiveCtx?.cwd || process.cwd(),
        effectiveCtx,
        effectiveSignal,
      );

      return {
        content: [{ type: "text", text: result.reportMarkdown }],
      };
    },
  });

  // 2. Slash Command: /adw <goal>
  pi.registerCommand("adw", {
    description: "Run the ADW verification gate (Jev scope, tests, diff stat, readiness) against a goal",
    handler: async (args, ctx) => {
      const goal = args?.trim();
      if (!goal) {
        ctx.ui?.notify?.("Usage: /adw <goal description>", "warning");
        return;
      }

      ctx.ui?.notify?.(`[pi-adw] Running ADW cycle for: ${goal}`, "info");
      const result = await executeAdwPipeline(goal, {}, ctx.cwd || process.cwd(), ctx);
      ctx.ui?.notify?.(
        `[pi-adw] Cycle finished: ${result.testStatus} (${result.scopeSize})`,
        result.testStatus === "fail" ? "error" : "info",
      );
      // The full report was previously dropped; put it in the transcript (no new turn).
      pi.sendMessage({ customType: "adw-report", content: result.reportMarkdown, display: true });
    },
  });
}
