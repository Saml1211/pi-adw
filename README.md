# pi-adw

A verification gate for the [Pi coding agent](https://github.com/earendil-works/pi), named after the AI Developer Workflow (ADW) idea from Dan Disler ([IndyDevDan](https://github.com/disler)). Call it before declaring a goal done.

It does **not** plan or edit code. In one call it:

1. Classifies the goal's scope and risk with TypeSafe Jev, if `TYPESAFE_API_KEY` or `~/.pi/agent/pi-jev.json` is set.
2. Runs the verify command. If you don't give one, it is detected from `package.json` (`bun run test` for Bun projects), `Cargo.toml` or pytest config. The result is `pass`, `fail` or `skipped`, never a false `pass`.
3. Reports the staged and unstaged diff stat.
4. Scores review readiness with Jev.

The command runs asynchronously in its own process group, so Pi stays responsive. Output is capped at 10 MB, and the timeout is 300 s (`PI_ADW_VERIFY_TIMEOUT_MS`). On timeout or abort the whole group gets SIGTERM, then SIGKILL after 2 s, and a timed-out or aborted run is always `fail`. If a descendant escapes the group with `setsid` and holds the output pipes, the call still settles 5 s after the first kill. The report says so on both timeout and abort, ahead of the output tail. A process-group ID that was recycled after the command exited is never signalled. Output is capped by bytes. It never compacts context: `ctx.compact()` aborts the running agent, and context management belongs to [self-compact-pi-agent](https://github.com/Saml1211/self-compact-pi-agent).

## Usage

- Tool: `adw(goal, verifyCommand?)`
- Command: `/adw <goal>` (the report is added to the transcript)

`verifyCommand` is a shell string such as `npm test`, at the same trust level as the agent's own bash tool.

## Verification

```bash
bun run test.ts
```
