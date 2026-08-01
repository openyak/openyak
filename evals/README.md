# OpenYak Evaluations

This package measures observable behavior of the OpenYak agent runtime. The
`runtime-v0` smoke suite uses a deterministic scripted provider, runs through
the production agent loop, and scores resulting side effects and runtime events
rather than trusting the model's final text.

## Run the offline smoke suite

From the repository root, after installing the backend development dependencies:

```bash
PYTHONPATH=backend:. python -m evals run-suite \
  evals/suites/runtime-v0/tasks \
  --output evals/results/runtime-v0/smoke-v0
```

The command requires no provider key and writes:

```text
suite-summary.json
<task-name>/manifest.json
<task-name>/attempts.jsonl
<task-name>/summary.json
<task-name>/workspace/
```

The generated SQLite session database is deleted after scoring because it may
contain the task prompt and tool payloads. `attempts.jsonl` retains bounded
event metadata but excludes prompt text, tool arguments, tool output, raw tool
errors, absolute paths, and final response text. Each attempt and manifest
records the allowed tools, permission policy, task budget, temperature, and
model revision when known.

## Current deterministic assertions

- `file_exists`: the expected relative path is a file.
- `file_absent`: the expected relative path does not exist.
- `text_equals`: UTF-8 text matches exactly, with optional newline normalization.
- `no_unexpected_changes`: the before/after snapshot contains no changes outside
  the explicit allowlist.
- `event_occurs`: a bounded runtime event contains the expected metadata.
- `tool_call_budget`: attempted tool calls remain within the task budget.

Workspace snapshots record relative paths, byte sizes, and SHA-256 digests. The
runtime reports created, modified, and deleted files with platform-independent
POSIX relative paths.

## Smoke tasks

| Family | Tasks | Observable proof |
|---|---:|---|
| File baseline | 3 | Exact create, content-preserving edit, and content-preserving rename. |
| Edit contract | 3 | Atomic batch success, rollback on one invalid edit, and recovery from conflicting modes. |
| Apply-patch contract | 4 | Exact add, update, delete, and recovery from malformed move syntax. |
| Bash execution | 3 | Exact output file, recovery after a nonzero exit, and bounded timeout behavior. |
| Python execution | 2 | Exact artifact creation and recovery after execution failure. |
| Permission | 3 | Denied write, bash, and Python calls produce errors with no filesystem side effect. |
| Payload repair | 1 | A malformed provider payload is normalized before execution. |
| Provider retry | 1 | One retryable provider failure emits telemetry and later succeeds. |

`tool_calls` counts distinct attempted call IDs, including denied calls;
`tool_executions` counts calls that passed permission checks and began execution.
Structured-tool metrics additionally report `schema_valid_at_1` before repair,
`repairs_applied`, `execution_success_at_1`, `tool_errors`, and
`recovered_after_tool_error`. Successful Python execution also reports only the
number of written files, never their paths or contents. Only booleans, counts,
bounded error and working-directory categories, numeric exit codes, tool names,
and call IDs are retained; arguments, commands, titles, paths, and tool output
remain excluded.

Failed deterministic outcomes use stable `outcome/*` and `budget/*` labels.
Harness timeouts and unexpected runtime exceptions are written separately as
`infrastructure/timeout` or `infrastructure/runtime`, so they are not silently
counted as model-quality failures.

## What the scripted suite proves

The offline suite verifies that the evaluation harness can drive the production
agent loop through model streaming, tool advertisement, permission evaluation,
argument validation, file execution, persistence, event publication, workspace
diffing, scoring, and result serialization.

It does **not** measure the quality of a real language model. Real model and
local-inference comparisons will use the same task/result contracts after the
offline regression layer is stable.

## Run the RealRouter live subset

Create a fresh RealRouter key and expose it only through the process environment:

```bash
export REALROUTER_API_KEY="<new-key>"
PYTHONPATH=backend:. python -m evals run-suite \
  evals/suites/runtime-v0/tasks \
  --output evals/results/runtime-v0/realrouter-gpt-5.6-luna \
  --provider realrouter \
  --model gpt-5.6-luna
```

Live mode runs twelve tasks covering exact write, edit, patch, bash, and Python
artifacts plus permission denial for write, bash, and Python execution. Atomic
rollback, explicit failure recovery, malformed-patch recovery, malformed provider
payload, timeouts, and forced-503 retry remain scripted because they require
deterministic fault injection. The API key is read only from
`REALROUTER_API_KEY`; it is not included in manifests, events, or summaries.
