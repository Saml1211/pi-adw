# pi-adw

Autonomous AI Developer Workflow (ADW) Software Factory engine for the **Pi Coding Agent**, inspired by Dan Disler's ([IndyDevDan](https://github.com/disler)) *FORGET Loop Engineering: Agentic Engineering is About THIS*.

## Overview

Rather than running unconstrained prompt loops ("vibe coding"), `pi-adw` coordinates the estate's new agentic primitives into a structured 5-phase software factory:

1. **Prime & Scope:** Detects repo stack, dirty files, and runs TypeSafe Jev scope & risk classification.
2. **Plan:** Enforces lazy senior dev constraints (stdlib-first, smallest diff).
3. **Build:** Changes applied with `pi-auto-validate` deterministically catching syntax errors in real-time.
4. **Checkpoint:** Evaluates context pressure; triggers `self_compact` if usage crosses threshold (75%).
5. **Verify:** Runs test suites; provides diff stat and Jev readiness score.

## Tool & Command

- Tool: `adw(goal, verifyCommand?, autoCompactAtPct?)`
- Command: `/adw <goal description>`

## Verification

```bash
node --input-type=module test.ts
```
