# Evaluation

## Goal

OpenYak evaluation measures whether a tool-using model completes a task
correctly, safely, and efficiently under a fixed runtime configuration. Unit
tests verify software behavior; this suite will measure model and policy
behavior. The two are complementary and must be reported separately.

## Evaluation units

The initial suite should contain versioned tasks in these categories:

| Category | Example capability | Primary metric |
|---|---|---|
| Structured tool use | Select a tool and produce valid arguments | execution-valid@1 |
| Multi-step execution | Complete a task requiring several dependent tools | task success |
| Context retention | Recover facts after long history and compaction | fact recall |
| Failure recovery | Recover from transient provider or tool errors | recovery rate |
| Local inference | Complete the same task through MLX/Ollama | success, TTFT, tokens/s |
| Permission safety | Refuse or request approval for unsafe operations | policy compliance |

Each task must include inputs, allowed tools, initial workspace fixture, expected
side effects, scorer configuration, time and cost budgets, and cleanup rules.

## Result schema

Every attempt produces one machine-readable record with this implemented
top-level schema:

```json
{
  "schema_version": 1,
  "suite_version": "runtime-v0",
  "task_id": "tool/read-and-summarize-001",
  "attempt": 0,
  "runtime_commit": "<git-sha>",
  "dirty_worktree": true,
  "provider": "<provider-id>",
  "model": "<model-id>",
  "configuration": {
    "allowed_tools": ["write"],
    "permissions": {"file_changes": "allow", "run_commands": "deny"},
    "budget": {"max_tool_calls": 3, "timeout_seconds": 30.0},
    "temperature": 0.0,
    "model_revision": null
  },
  "duration_ms": 123.4,
  "tool_calls": 1,
  "tool_executions": 1,
  "retry_count": 0,
  "token_usage": {},
  "cost_usd": 0.0,
  "failure_labels": [],
  "infrastructure_error": null,
  "workspace_changes": {"openyak_written/result.txt": "created"},
  "score": {"passed": true, "metrics": {}, "assertions": []},
  "events": []
}
```

`quantization`, hardware, and local-runtime launch metadata belong to the future
local-inference benchmark configuration; the current runtime harness does not
claim to capture them. Secrets, raw credentials, unrestricted user content,
tool arguments, tool output, raw tool errors, and absolute paths must never be
written to evaluation records.

## Scoring policy

Prefer deterministic scorers:

- JSON/schema validation for structured output;
- filesystem diffs for file tasks;
- exit code and expected stdout fragments for command tasks;
- exact or normalized field comparison for extraction;
- permission-event inspection for safety tasks; and
- fact-level recall and contradiction checks for context tasks.

Use an LLM judge only when deterministic scoring cannot capture the requirement.
Judge-based metrics must record judge model, revision, prompt, temperature, and
the original structured rubric. A sample must be manually audited before a
judge score is used in a headline result.

## Repetition and uncertainty

- Use temperature zero when supported for deterministic baselines.
- Run nondeterministic configurations at least three times per task.
- Publish the number of attempts and confidence intervals with aggregate rates.
- Do not compare models from a single cherry-picked run.
- Separate infrastructure failures from model-quality failures.

## Regression policy

Every fixed production failure should add the smallest reproducing case to a
versioned failure set. Pull requests affecting routing, tools, context, provider
adapters, permissions, or retry behavior should run a fast offline subset. Full
provider and local-hardware benchmarks may run on a scheduled or manually
triggered workflow.

A regression is any statistically or deterministically meaningful decline in:

- task success or execution-valid@1;
- context fact recall;
- safety-policy compliance;
- cost per successful task;
- p95 end-to-end latency; or
- unrecovered failure rate.

## Offline MVP

The implemented `runtime-v0` vertical slice contains twenty deterministic smoke
tasks. In addition to exact file operations, permission denial, malformed
payload repair, and provider retry, it covers edit single/batch behavior, atomic
rollback, apply-patch operations, bash nonzero-exit recovery and timeout, and
Python artifact creation and failure recovery. Scripted provider outputs still
pass through the production agent loop, permission policy, tool validation,
execution, persistence, event publication, and scoring.

Run it from the repository root:

```bash
PYTHONPATH=backend:. python -m evals run-suite \
  evals/suites/runtime-v0/tasks \
  --output evals/results/runtime-v0/smoke-v0
```

The result directory contains `suite-summary.json` plus one task directory with
`manifest.json`, `attempts.jsonl`, `summary.json`, and the scored workspace for
each task. Raw session databases are removed after scoring, and JSONL event
records exclude prompts, tool arguments, tool outputs, and final response text.
Tool failures retain only bounded categories, numeric exit codes, and relative
scope labels. Failed task outcomes and harness failures receive stable labels;
an infrastructure timeout is recorded as `infrastructure/timeout` rather than
terminating without an attempt artifact.

For a real-model run through RealRouter's OpenAI-compatible chat-completions
endpoint, set a newly created key in `REALROUTER_API_KEY` and add
`--provider realrouter --model gpt-5.6-luna` to the suite command. Live mode
selects only tasks whose failure condition can be produced by a real model;
deterministic rollback, malformed-payload, self-correction, and provider-503
cases stay in the scripted fault-injection suite. Twelve tasks are currently
eligible for live-model execution.

An exploratory Terra pre/post run of the eight-task subset improved from 5/8
to 7/8 after tightening the edit contract and documenting move syntax. The
remaining failed batch task produced the correct file only after a second call,
so it correctly failed its one-call budget. See
[`evals/reports/terra-tool-v0-pre-post.md`](evals/reports/terra-tool-v0-pre-post.md).

After expanding the live subset to twelve tasks, a second Terra contract
hardening comparison improved strict success from 8/12 to 11/12. All twelve
post-fix tasks reached the correct deterministic file or permission outcome;
the remaining strict failure was a bash task that recovered successfully on its
second call but exceeded a one-call budget. See
[`evals/reports/terra-tool-v1-v2.md`](evals/reports/terra-tool-v1-v2.md).

Two additional repetitions per model produced a balanced three-run comparison.
Terra and Sol both reached 34/36 strict successes and 25/27 first-execution
successes among tasks where execution was allowed. Terra reached 36/36 correct
final outcomes; Sol reached 35/36 because one successful bash execution wrote to
the wrong directory. See
[`evals/reports/terra-sol-tool-v2-repeated.md`](evals/reports/terra-sol-tool-v2-repeated.md).

## Comparison requirements

A benchmark comparison is valid only when it reports:

- task-suite and failure-set versions;
- runtime commit SHA and dirty-worktree status;
- model and provider revisions;
- sampling and reasoning parameters;
- tool set and permission mode;
- hardware and local-runtime configuration; and
- number of attempts, exclusions, and infrastructure failures.

## Status

Protocol drafted. Twenty versioned, fully offline smoke tasks, their fixtures,
workspace snapshot/diff layer, deterministic scorers, result writer, suite CLI,
structured-tool telemetry, stable failure labeling, sanitized error telemetry,
reproducible configuration snapshots, and an explicit offline CI smoke gate are
implemented. A
credential-safe RealRouter adapter and twelve-task live subset are implemented.
Exploratory Luna results, contract-hardening comparisons, and balanced three-run
Terra/Sol diagnostics exist, but are not yet a published baseline because the
worktree was dirty and provider revisions and runtime conditions were unpinned.
Repeated attempts, additional provider adapters, local-inference measurements,
and benchmark aggregation remain open. Scripted smoke results prove runtime
behavior, not real-model quality.
