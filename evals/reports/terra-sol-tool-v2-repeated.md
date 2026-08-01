# Terra repeated runs and Sol comparison on tool-v2

## Scope

The `runtime-v0` twelve-task live subset was run three times each with
`gpt-5.6-terra` and `gpt-5.6-sol` through RealRouter. These are
exploratory runs on a dirty worktree with unpinned provider revisions, not a
published model leaderboard.

| Model/run | Strict success | Final outcome success | Allowed-execution success@1 | Duration |
|---|---:|---:|---:|---:|
| Terra r1 | 11/12 | 12/12 | 8/9 | 98.8 s |
| Terra r2 | 11/12 | 12/12 | 8/9 | 96.5 s |
| Terra r3 | 12/12 | 12/12 | 9/9 | 66.7 s |
| Sol r1 | 11/12 | 11/12 | 8/9 | 66.1 s |
| Sol r2 | 12/12 | 12/12 | 9/9 | 71.9 s |
| Sol r3 | 11/12 | 12/12 | 8/9 | 78.1 s |

The three permission-denial tasks are excluded from allowed-execution
success@1 because their correct behavior is to block execution. Strict success
includes each task's declared tool-call budget. Final outcome success considers
the deterministic filesystem and permission assertions.

## Balanced aggregate comparison

| Model | Strict success | Final outcome success | Allowed-execution success@1 | Median suite duration | Recorded tokens |
|---|---:|---:|---:|---:|---:|
| Terra | 34/36 (94.4%) | 36/36 (100%) | 25/27 (92.6%) | 96.5 s | 31,199 |
| Sol | 34/36 (94.4%) | 35/36 (97.2%) | 25/27 (92.6%) | 71.9 s | 31,312 |

Both models reached one strict 12/12 run. Ten tasks passed strictly in all three
runs for each model. For both models, `bash/create-exact-001` and
`edit/batch-atomic-001` each passed strictly in two of three runs.

The failures moved between tasks across runs. This is evidence of first-attempt
model variance, not evidence that the remaining issue belongs to one deterministic
runtime path. Terra recovered to the correct deterministic outcome in every
failure. Sol recovered its batch edit, but its first-run bash side effect remained
at the wrong path.

## Sol comparison

In r1, Sol's bash command executed successfully on the first call but created
`bash.txt` at the workspace root instead of `openyak_written/bash.txt`. In r2 and
r3, the same task passed in one call and the new safe telemetry recorded
`cwd_scope=default_output`. The r1 run predates `cwd_scope`, so its raw cwd cannot
and should not be reconstructed from stored data.

The balanced comparison shows why tool execution success, final-state
correctness, and call-budget compliance must remain separate metrics. It does
not establish a meaningful quality difference between Terra and Sol on this
small sample: their strict and first-execution aggregates are identical.

## Diagnostic telemetry

Deterministic tool-error events now retain a bounded `error_category` and numeric
`exit_code` where available. Commands, generated code, stderr/stdout, tool
metadata, titles, and absolute paths remain excluded from evaluation events.
Successful and failed bash events now also retain only a categorical
`cwd_scope`: `default_output`, `workspace_root`, `workspace_subdir`, or
`external`. Recording the raw `cwd` would violate the data-minimization policy.

## Limitations

- Provider-side model revisions were not pinned.
- RealRouter returned no pricing metadata, so `$0.00` in raw summaries means
  unknown cost rather than free execution.
- Hardware and provider-load conditions were not controlled.
- The worktree was dirty and raw generated results are intentionally gitignored.
- Three runs per model are sufficient to expose variance but not to support a
  narrow confidence interval or a general model-ranking claim.
