# Terra Tool Contract Pre/Post Evaluation

## Scope

This is an exploratory, single-attempt comparison of the same eight
`runtime-v0` live tasks through RealRouter using `gpt-5.6-terra`. The task
manifests, scorers, permissions, and model were held constant. The changed
runtime advertised mutually exclusive edit modes with JSON Schema `oneOf`,
validated nested batch edits, documented apply-patch move syntax, and unified
relative delete-path resolution.

The runs used a dirty worktree and one attempt per task. They are useful for
failure analysis, but are not a statistically stable headline benchmark.

## Result

| Run | Passed | Pass rate | Total duration |
|---|---:|---:|---:|
| Pre-fix | 5 / 8 | 62.5% | 75.0 s |
| Post-fix | 7 / 8 | 87.5% | 46.1 s |
| Difference | +2 tasks | +25 percentage points | -28.9 s |

| Task | Pre-fix | Post-fix | Observed change |
|---|---|---|---|
| Apply-patch add | Pass | Pass | Stable one-call success |
| Apply-patch delete | Pass | Pass | Stable one-call success after path fix |
| Apply-patch update | Pass | Pass | Stable one-call success |
| Edit batch atomic | Fail | Fail | Changed from three contract errors and no side effect to one path error, recovery, and correct file; still exceeded the one-call budget |
| File create | Pass | Pass | Stable one-call success |
| File edit | Fail | Pass | Changed from four contract errors and no side effect to one path error followed by successful recovery |
| File rename | Fail | Pass | Changed from an unparseable patch to one-call success |
| Permission deny | Pass | Pass | Stable deny with zero executions and zero side effects |

## Interpretation

The edit schema change removed the repeated conflicting-mode error observed in
the pre-fix run. The remaining edit failure was a semantically wrong file path,
not a schema-mode violation. The batch task intentionally remains failed: its
workspace result was correct, but it required two calls despite a one-call
budget. Loosening that budget would hide a first-attempt quality regression.

The rename description change coincided with a one-call successful move in the
post-fix run. Because model output is nondeterministic and this comparison has
one attempt per task, repeated runs are required before attributing latency or
success-rate changes causally.

Cost is not compared because pricing metadata for this model was unavailable to
the evaluation runtime. Raw task arguments, outputs, credentials, and session
databases are excluded from this report.
