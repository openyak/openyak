from pathlib import Path

import yaml


WORKFLOW_PATH = Path(__file__).parents[3] / ".github" / "workflows" / "release.yml"


def test_every_release_upload_preserves_draft_and_prerelease_state() -> None:
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text())
    publish_steps = workflow["jobs"]["publish"]["steps"]
    release_steps = [
        step
        for step in publish_steps
        if step.get("uses") == "softprops/action-gh-release@v2"
    ]

    assert len(release_steps) == 2
    for step in release_steps:
        assert step["with"]["draft"] is True, step["name"]
        assert step["with"]["prerelease"] == "${{ contains(github.ref_name, '-') }}"
