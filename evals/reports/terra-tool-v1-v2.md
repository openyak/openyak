# Terra tool suite: contract hardening comparison

## Scope

This is an exploratory, single-attempt comparison using the `runtime-v0` live
subset through RealRouter with `gpt-5.6-terra`. Both runs used a dirty worktree,
so the numbers are diagnostic evidence rather than a published model baseline.

| Run | Live tasks | Strict passes | Strict pass rate | Final outcome success |
|---|---:|---:|---:|---:|
| tool-v1, before output-contract fixes | 12 | 8 | 66.7% | 9/12 |
| tool-v2, after output-contract fixes | 12 | 11 | 91.7% | 12/12 |

`Strict pass` includes the declared tool-call budget. `Final outcome success`
counts deterministic file and permission assertions without treating a recovered
extra call as task failure. The two metrics are intentionally kept separate.

## Changes between runs

- Relative write paths already beginning with `openyak_written/` became
  idempotent instead of producing a duplicated output-directory prefix.
- Bash, edit, apply-patch, and code-execute schemas now state the output path
  contract explicitly.
- `OPENYAK_WORKSPACE` and `OPENYAK_OUTPUT_DIR` are documented as Python namespace
  variables, not environment variables.
- Evaluation events stopped retaining tool titles because a code-execute title
  can contain generated code and absolute paths.

## Observed changes

| Task | tool-v1 | tool-v2 | Interpretation |
|---|---|---|---|
| `apply-patch/add-exact-001` | Nested `openyak_written/openyak_written/added.txt` | One-call exact pass | Idempotent path handling removed an avoidable semantic trap. |
| `code_execute/create-exact-001` | Correct artifact after one failed call | One-call exact pass | The namespace-variable example improved first-attempt execution. |
| `edit/batch-atomic-001` | One semantic path error, no edit | One-call exact pass | Explicit relative-path guidance aligned the model with runtime resolution. |
| `bash/create-exact-001` | Correct content at the wrong path after recovery | Correct content at the right path after recovery | Path guidance fixed the side effect, but first-attempt command reliability remains open. |

## Remaining failure

`bash/create-exact-001` satisfied every filesystem assertion in tool-v2 but made
two calls: the first returned exit code 1 and the second succeeded. It therefore
failed the deliberate one-call budget. This is a successful recovery and a
first-attempt reliability failure at the same time; reporting only either label
would hide useful information.

## Limitations

- One attempt per task is not enough to estimate model variance.
- RealRouter did not provide pricing metadata for this model, so reported cost is
  zero and must not be interpreted as free execution.
- The worktree was dirty and the provider model revision was not pinned.
- No Sol comparison was run for this expanded twelve-task subset.
