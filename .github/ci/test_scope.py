import unittest
from scope import needs_checks


class ChangeSelection(unittest.TestCase):
    def test_docs_and_v1_do_not_build_v2(self):
        self.assertFalse(needs_checks([
            "README.md", "README.zh-CN.md", "CONTRIBUTING.md",
            "brandkit/banners/readme-dark.png", "brandkit/README.md",
            "brandkit/logos/app-icon-1024.png", "desktop-tauri/src/main.rs",
        ]))

    def test_runtime_and_build_inputs_trigger_checks(self):
        for path in ["app/src/main/index.ts", "app/test/browserControl.test.ts",
                     "core/src/store.rs", "core/Cargo.lock", "package-lock.json",
                     "package.json", "mise.toml", ".npmrc", ".cargo/config.toml",
                     ".github/workflows/v2.yml", ".github/ci/scope.py"]:
            with self.subTest(path=path):
                self.assertTrue(needs_checks(["README.md", path]))

    def test_removed_or_moved_source_still_triggers_checks(self):
        # git diff --no-renames supplies both old and new paths for a move.
        self.assertTrue(needs_checks(["core/src/store.rs", "docs/old-store.rs"]))

    def test_empty_diff_has_no_runtime_work(self):
        self.assertFalse(needs_checks([""]))


if __name__ == "__main__":
    unittest.main()
