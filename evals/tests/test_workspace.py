from pathlib import Path

from evals.workspace import prepare_workspace


def test_workspace_diff_reports_a_created_file(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "keep.txt").write_text("unchanged\n", encoding="utf-8")

    workspace = prepare_workspace(fixture, tmp_path / "run")
    output = workspace.path / "openyak_written" / "result.txt"
    output.parent.mkdir()
    output.write_text("OpenYak evaluation passed.\n", encoding="utf-8")

    assert workspace.diff().changes == {
        "openyak_written/result.txt": "created",
    }
