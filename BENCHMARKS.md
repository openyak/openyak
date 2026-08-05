# Benchmarks

## Reporting standard

This document will publish reproducible OpenYak runtime results. It intentionally
contains no estimated or hand-entered performance claims. A result is added only
after the benchmark runner, task suite, raw machine-readable output, and hardware
metadata are committed or attached to a release.

See [`EVALUATION.md`](EVALUATION.md) for the evaluation protocol and
[`FAILURE_ANALYSIS.md`](FAILURE_ANALYSIS.md) for failure labels.

## Required benchmark metadata

Every result table must record:

- date and OpenYak commit SHA;
- operating system, CPU/GPU, unified/system memory;
- provider and model revision;
- quantization format and effective context window;
- local-runtime version and launch parameters;
- task-suite and failure-set versions;
- concurrency, warm/cold state, and attempt count; and
- sampling, reasoning, output-budget, and routing-policy settings.

## Headline metrics

### Agent and structured generation

| Configuration | Task success | Tool selection | Schema-valid@1 | Execution-valid@1 | Semantic accuracy | Repair attempt | Repair success | Repair extra tokens | Repair latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Published model baseline pending | — | — | — | — | — | — | — | — | — |

`schema-valid@1` measures whether the first generated arguments satisfy the
advertised schema before runtime repair. `execution-success@1` requires the
first attempted tool call to finish with a successful tool result. Recovery
after tool feedback and repair rate are reported separately so later correction
does not inflate first-attempt validity.

The `structured-v0` runner writes this exact table shape to
`structured-summary.md` from the machine-readable aggregate. Generate a row
without manual arithmetic:

```bash
PYTHONPATH=backend:. python -m evals run-suite \
  evals/suites/structured-v0/tasks \
  --output evals/results/structured-v0/<run-id> \
  --provider realrouter \
  --model <model-id> \
  --tool-call-mode native
```

Replace the provider with `ollama` and select an installed local model to run
the same five-task live subset. Prompt-based comparisons change only
`--tool-call-mode prompt`; both modes retain the same attempt and aggregate
schemas. The ten-task scripted suite intentionally injects failures, so its low
first-attempt rates validate attribution and repair math rather than model
quality.

### Context management

| Configuration | Fact recall | Contradiction rate | Tokens before | Tokens after | Reduction | Task success after compaction |
|---|---:|---:|---:|---:|---:|---:|
| Baseline pending | — | — | — | — | — | — |

Context evaluation must include short controls, near-window tasks, and tasks that
force every compaction stage. Token reduction without retained task correctness
is not a successful result.

### Reliability

| Configuration | Retry recovery | Fallback recovery | Unrecovered failures | Tool-loop rate | Median extra latency |
|---|---:|---:|---:|---:|---:|
| Baseline pending | — | — | — | — | — |

Results must distinguish provider, runtime, tool, permission, model-output, and
evaluation-infrastructure failures.

### Local inference

| Hardware | Runtime | Model | Quantization | Context | Concurrency | Cold start | TTFT p50/p95 | Tokens/s | Peak memory |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| Baseline pending | — | — | — | — | — | — | — | — | — |

At minimum, local measurements should cover concurrency 1, 2, and 4 and report
both cold and warm behavior. A local model is not considered comparable to a
cloud model unless it is also run on the same functional task subset.

### Safety

| Policy configuration | Unsafe requests | Correct deny | Correct ask | Incorrect allow | Secret exposure |
|---|---:|---:|---:|---:|---:|
| Baseline pending | — | — | — | — | — |

## Raw results

Raw results should be stored by suite version and run identifier, for example:

```text
evals/results/runtime-v0/<run-id>/
    manifest.json
    attempts.jsonl
    summary.json
```

Generated summaries must be reproducible from `attempts.jsonl`; headline tables
must not depend on manual spreadsheet edits.

Each suite output also contains `suite-summary.json` and the derived
`structured-summary.md`. Rates use explicit eligible denominators: semantic
accuracy excludes tasks without semantic assertions, and repair success and
overhead exclude calls where repair was not attempted.

## Exploratory diagnostics

The following balanced results validate the runner and guide tool-contract work.
They are not headline benchmarks because the worktree was dirty, provider
revisions and runtime conditions were unpinned, and RealRouter did not provide
price metadata.

| Configuration | Attempts | Strict success | Final outcome | Allowed execution@1 | Median 12-task duration |
|---|---:|---:|---:|---:|---:|
| Terra tool-v2 | 36 | 34/36 (94.4%) | 36/36 (100%) | 25/27 (92.6%) | 96.5 s |
| Sol tool-v2 | 36 | 34/36 (94.4%) | 35/36 (97.2%) | 25/27 (92.6%) | 71.9 s |

See
[`evals/reports/terra-sol-tool-v2-repeated.md`](evals/reports/terra-sol-tool-v2-repeated.md)
for task-level interpretation and limitations.

The first `structured-v0` live comparison found 5/5 first-attempt schema and
execution validity for Terra, Sol, and local Qwen 3.6 27B, while semantic task
success separated Terra (3/5) from Sol and Qwen (5/5). Sol also passed the same
tasks through the prompt-based path. These are single-run exploratory results,
not a headline baseline. See
[`evals/reports/structured-v0-exploratory.md`](evals/reports/structured-v0-exploratory.md).

## Status

Benchmark contract and structured aggregation are implemented; no controlled
structured model baseline has been published yet.
