from pathlib import Path

from evals.scoring import score_workspace
from evals.task import WorkspaceScorerConfig
from evals.workspace import prepare_workspace


def test_workspace_score_passes_for_the_only_expected_exact_file(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    workspace = prepare_workspace(fixture, tmp_path / "run")
    output = workspace.path / "openyak_written" / "result.txt"
    output.parent.mkdir()
    output.write_text("OpenYak evaluation passed.\n", encoding="utf-8")
    config = WorkspaceScorerConfig.model_validate({
        "type": "workspace",
        "assertions": [
            {"type": "file_exists", "path": "openyak_written/result.txt"},
            {
                "type": "text_equals",
                "path": "openyak_written/result.txt",
                "value": "OpenYak evaluation passed.\n",
            },
            {
                "type": "no_unexpected_changes",
                "allowed": ["openyak_written/result.txt"],
            },
        ],
    })

    score = score_workspace(config, workspace)

    assert score.passed is True
    assert score.metrics == {
        "assertions_total": 3,
        "assertions_passed": 3,
        "file_exists_passed": 1,
        "file_absent_passed": 0,
        "text_equals_passed": 1,
        "no_unexpected_changes_passed": 1,
        "unexpected_changes": 0,
    }


def test_workspace_score_fails_when_file_content_differs(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    workspace = prepare_workspace(fixture, tmp_path / "run")
    output = workspace.path / "result.txt"
    output.write_text("wrong\n", encoding="utf-8")
    config = WorkspaceScorerConfig.model_validate({
        "type": "workspace",
        "assertions": [
            {"type": "text_equals", "path": "result.txt", "value": "expected\n"},
        ],
    })

    score = score_workspace(config, workspace)

    assert score.passed is False
    assert score.metrics["text_equals_passed"] == 0


def test_workspace_score_fails_for_an_unexpected_change(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    workspace = prepare_workspace(fixture, tmp_path / "run")
    (workspace.path / "unexpected.txt").write_text("surprise\n", encoding="utf-8")
    config = WorkspaceScorerConfig.model_validate({
        "type": "workspace",
        "assertions": [
            {"type": "no_unexpected_changes", "allowed": []},
        ],
    })

    score = score_workspace(config, workspace)

    assert score.passed is False
    assert score.metrics["unexpected_changes"] == 1
