# Structured-v0 exploratory comparison

Date: 2026-08-05

This single-attempt run validates the `structured-v0` live path and reveals
candidate failures. It is not a published benchmark: the worktree was dirty,
provider revisions and price metadata were unavailable, and no repeated-run
uncertainty was measured.

## Results

| Configuration | Task success | Tool selection | Schema-valid@1 | Execution-valid@1 | Semantic accuracy | Total duration | Median task duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| Terra / native | 3/5 (60%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 3/5 (60%) | 19.0 s | 3.55 s |
| Sol / native | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 22.3 s | 4.36 s |
| Sol / prompt | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 66.5 s | 9.82 s |
| Qwen 3.6 27B / Ollama / native | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 139.4 s | 26.37 s |

All configurations had zero runtime repair attempts. Repair success and repair
overhead are therefore not applicable rather than zero.

## Configuration

- Suite: `structured-v0`, five live tasks, one attempt per task.
- Cloud adapter: RealRouter-compatible local proxy, native and prompt modes.
- Local adapter: Ollama 0.20.7, `qwen3.6:27b`, Q4_K_M, native mode.
- Local hardware: Apple M4 Max, 128 GiB unified memory; Ollama reported about
  107.5 GiB available to Metal.
- Sampling: OpenYak evaluation agent temperature 0.
- Concurrency: one task and one model request at a time.

## Findings

Terra generated syntactically perfect calls but used workspace-root absolute
paths on two tasks. The write tool executed successfully, yet deterministic
workspace scoring and semantic path normalization rejected the wrong resource
scope. This is the intended distinction between schema, execution, and semantic
correctness.

Sol passed all five tasks in both modes. Prompt mode preserved the same result
schema but took about three times the total duration of native mode in this
single run. More repetitions are required before treating that ratio as stable.

Qwen passed all tasks and all first-attempt structured metrics. It made nine
tool-call attempts across five tasks, however: four redundant post-success
calls were blocked and recorded as tool errors. This is a reliability and
efficiency failure that first-attempt validity alone does not expose and should
be promoted into the loop/repetition failure family.

## Evaluation fixes discovered during the run

The first Terra run exposed two harness problems that were fixed before the
table above was generated:

1. a scripted-only expected failure event was incorrectly applied to live mode;
2. semantic path equality did not normalize equivalent paths under
   `openyak_written`, while still needing to reject workspace-root paths.

Both fixes have deterministic regression tests. The table contains only the
post-fix runs.

## Publication requirements

Before promoting these results to the headline benchmark, run at least three
attempts per task, pin the runtime commit and provider revision, record local
launch/context settings and peak memory, and retain or attach the generated
`attempts.jsonl`, `suite-summary.json`, and `structured-summary.md` artifacts.
