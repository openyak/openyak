# Failure Analysis

## Purpose

OpenYak treats failures as versioned evaluation data rather than isolated bug
reports. This document defines the initial taxonomy used by evaluation records,
regression tasks, retry policies, and model-routing decisions.

## Taxonomy

| Label | Meaning | Typical handling |
|---|---|---|
| `routing/ineligible-model` | Selected model lacks a required capability or context window | Filter before inference |
| `routing/suboptimal-model` | Eligible model violates the intended quality, latency, or cost objective | Router regression |
| `generation/malformed-tool-call` | Tool call cannot be parsed into the canonical name/arguments shape | Repair once, then return feedback |
| `generation/schema-invalid` | Required field, type, or enum constraint is invalid | Return validation feedback |
| `generation/schema-underconstrained` | Arguments pass the advertised schema but violate a tool's real mode contract | Tighten or split the schema |
| `generation/wrong-tool` | Call is valid but the selected tool cannot satisfy the task | Model feedback or fallback |
| `generation/semantic-arguments` | Arguments are syntactically valid but target the wrong resource or operation | Task scorer failure |
| `context/omission` | Required evidence was removed, ignored, or not retrieved | Context-policy regression |
| `context/contradiction` | Summary or answer conflicts with retained evidence | Compaction failure |
| `provider/rate-limit` | Provider rejects the request due to quota or rate | Retry with server hint/backoff |
| `provider/overload` | Provider lacks transient capacity | Bounded retry or fallback |
| `provider/auth` | Credentials are absent or invalid | Terminal user action |
| `provider/context-overflow` | Request exceeds the effective context limit | Compact; do not blindly retry |
| `runtime/local-oom` | Local inference exceeds available memory | Smaller/quantized model or lower concurrency |
| `runtime/timeout` | Inference or tool execution exceeds its deadline | Cancel, retry, or fallback by policy |
| `tool/execution-error` | Tool accepted the call but execution failed | Return structured error feedback |
| `tool/contract-underdocumented` | A supported operation or syntax is absent from the model-facing tool description | Correct the advertised contract |
| `tool/path-resolution` | Equivalent file operations resolve the same relative path differently | Unify safe path resolution |
| `tool/repetition-loop` | Identical calls repeat without progress | Warn once, then stop |
| `permission/incorrect-allow` | Unsafe action proceeds without required approval | Safety regression |
| `permission/incorrect-deny` | Allowed work is blocked | Policy usability regression |
| `security/workspace-escape` | File or command path escapes the configured workspace | Deny before execution |
| `security/secret-exposure` | A secret enters a prompt, event, log, or persisted artifact | Redact and treat as critical |
| `outcome/workspace` | One or more deterministic workspace assertions fail | Inspect the task trace and final diff |
| `outcome/expected-event` | A required bounded runtime event is absent | Inspect policy and runtime telemetry |
| `budget/tool-calls` | The task exceeds its declared tool-call budget | Treat final correctness and efficiency separately |
| `infrastructure/timeout` | The evaluation harness exceeds its task deadline | Report separately from model quality |
| `infrastructure/runtime` | The harness encounters an unexpected runtime failure | Report separately and repair the harness |

## Failure record

Each promoted failure case should include:

```yaml
id: generation-schema-invalid-001
first_seen_commit: <git-sha>
task_id: tool/example-001
configuration: {}
expected: "A valid read tool call"
observed: "Missing file_path"
labels:
  - generation/schema-invalid
root_cause: "Pending"
mitigation: "Pending"
regression_test: null
status: open
```

Raw prompts or tool values must be minimized and scrubbed before a production
failure is promoted into the public set.

## First frozen failures

| Failure | Evidence | Primary label | Regression task | Status |
|---|---|---|---|---|
| Luna, Terra, and Sol repeatedly supplied single and batch edit arguments together | Schema-valid@1 was true while execution-success@1 was false; repeated calls made no workspace change | `generation/schema-underconstrained` | `edit/self-correct-conflicting-modes-001` | Mitigated locally |
| Luna and a later Terra run generated unparseable rename patches | Tool feedback reported no file operations and the workspace remained unchanged | `tool/contract-underdocumented` | `apply-patch/self-correct-malformed-001` | Mitigated locally |
| Apply-patch delete resolved a relative path differently from update/move | Deterministic delete task failed while the equivalent move task passed | `tool/path-resolution` | `apply-patch/delete-exact-001` | Fixed locally |
| Terra addressed the workspace-root `config.txt` path before recovering to the writable path | Schema validation passed, the first execution reported file-not-found, and a later call succeeded | `generation/semantic-arguments` | `edit/batch-atomic-001` | Mitigated locally |
| Terra prefixed an apply-patch add path with `openyak_written/`, which the runtime prefixed a second time | Execution succeeded but the deterministic workspace diff found a nested unexpected path | `tool/path-resolution` | `apply-patch/add-exact-001` | Fixed locally |
| Terra treated the code-execute output path contract ambiguously and needed execution feedback | The first execution failed; the second created the exact artifact | `tool/contract-underdocumented` | `code_execute/create-exact-001` | Mitigated locally |
| Terra needed two bash calls to create an exact file | Final content and location were correct, but execution-success@1 was zero and the one-call budget failed | `generation/command-error` | `bash/create-exact-001` | Open |
| Evaluation tool titles retained generated code fragments and absolute paths | A live code-execute result contained a code/path-bearing title even though arguments and output were excluded | `evaluation/data-minimization` | `code_execute/create-exact-001` | Fixed locally |
| Sol executed a bash command successfully in the wrong working-directory scope | Exit status was successful, but the workspace diff found `bash.txt` at the workspace root instead of the output directory | `generation/semantic-arguments` | `bash/create-exact-001` | Open |

## Known architectural risks

The following risks are already visible from the current implementation and
should not be hidden by project positioning:

1. Model resolution is deterministic, not task-aware, so it cannot yet optimize
   measured quality, latency, and cost jointly.
2. Tool argument validation implements required fields, basic types, and enums,
   not every JSON Schema constraint.
3. Tool-call repair normalizes known payload shapes but does not guarantee
   semantic correctness.
4. Full compaction relies on a model-generated summary; its faithfulness is not
   yet measured by a fixed fact-retention suite.
5. Provider retry exists, but failure-aware model fallback is not yet a general
   runtime policy.
6. Rapid-MLX and Ollama are integrated, but quantization, concurrency, peak
   memory, and latency have no published controlled benchmark.
7. Python `code_execute` runs in the backend process. A fresh namespace limits
   state carry-over but is not an OS sandbox.
8. `code_execute` currently uses a worker thread. An async timeout can return
   control to the agent, but Python cannot safely terminate that thread, so a
   process boundary is required before claiming hard cancellation.

## Review loop

For every material production or benchmark failure:

1. reproduce it with the smallest safe fixture;
2. assign one primary and any secondary taxonomy labels;
3. separate model, policy, runtime, tool, and infrastructure causes;
4. add the reproducer to the frozen failure set;
5. implement the mitigation without weakening unrelated safety checks;
6. run the complete affected task family; and
7. publish both the improvement and any new trade-off in `BENCHMARKS.md`.

## Status

Initial taxonomy, known-risk inventory, and scored failure reproductions are
implemented. A standalone machine-readable failure-record format and published
repeated-run baseline remain open.
