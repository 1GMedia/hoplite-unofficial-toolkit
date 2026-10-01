"""Only synthetic fixtures; no browser, credentials, or network access."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "env_json.py"
SPEC = importlib.util.spec_from_file_location("env_json", SCRIPT)
env_json = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(env_json)


class EnvironmentTests(unittest.TestCase):
    def test_exact_strings_and_empty_values_survive(self):
        values = {
            "FIXTURE_SECRET": "fixture-only-$HOME#literal\\n ",
            "FIXTURE_MAP": '{"example":"fixture"}',
            "FIXTURE_URL": "https://example.invalid/a?fixture=1&other=2",
            "FIXTURE_EMPTY": "",
            "FIXTURE_UNICODE": "fixture-caf\u00e9",
            "FIXTURE_PROEJCT_ID": "fixture-spelling-preserved",
        }
        decoded = env_json.parse_environment(json.dumps(values))
        self.assertEqual(decoded, values)
        rendered = env_json.render_dotenv(decoded)
        # Read the deliberately limited single-quote format to check fidelity.
        readback = {}
        for line in rendered.splitlines():
            key, quoted = line.split("=", 1)
            self.assertTrue(quoted.startswith("'") and quoted.endswith("'"))
            readback[key] = quoted[1:-1]
        self.assertEqual(readback, values)

    def test_duplicate_names_are_rejected_before_import(self):
        with self.assertRaises(env_json.EnvError):
            env_json.parse_environment('{"FIXTURE_KEY":"first","FIXTURE_KEY":"second"}')

    def test_invalid_shapes_names_and_values_do_not_get_coerced(self):
        examples = ["[]", "null", '{"BAD-NAME":"fixture"}', '{"bad=value":"fixture"}']
        examples += [json.dumps({"FIXTURE_KEY": value}) for value in [None, 1, True, [], {}]]
        examples += [json.dumps({"FIXTURE_KEY": "fixture\x00nul"}), '{"FIXTURE_KEY":"\\ud800"}']
        for source in examples:
            with self.subTest(source=source), self.assertRaises(env_json.EnvError):
                env_json.parse_environment(source)

    def test_valid_strings_that_need_individual_fields_are_not_reescaped(self):
        for value in ["fixture's quote", "fixture\nsecond line", "fixture\rcarriage return"]:
            expected = env_json.parse_environment(json.dumps({"FIXTURE_KEY": value}))
            self.assertEqual(expected["FIXTURE_KEY"], value)
            with self.assertRaises(env_json.EnvError) as caught:
                env_json.render_dotenv(expected)
            self.assertNotIn(value, str(caught.exception))

    def test_comparison_finds_mismatches_without_values_and_preserves_extra_keys(self):
        receipt = env_json.compare_environment(
            {"FIXTURE_A": "fixture-expected", "FIXTURE_B": "fixture-missing"},
            {"FIXTURE_A": "fixture-actual", "KEEP_EXISTING": "fixture-unrelated"},
        )
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["missing_keys"], ["FIXTURE_B"])
        self.assertEqual(receipt["mismatched_keys"], ["FIXTURE_A"])
        self.assertEqual(receipt["additional_keys"], ["KEEP_EXISTING"])
        self.assertNotIn("fixture-expected", json.dumps(receipt))
        self.assertNotIn("fixture-actual", json.dumps(receipt))
        self.assertTrue(env_json.compare_environment({"A": ""}, {"A": "", "B": "extra"})["ok"])

    def test_private_file_permissions_and_no_overwrite_or_symlink_following(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "fixture.env"
            env_json.write_private_file(output, "FIXTURE_KEY='fixture-value'\n")
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                env_json.write_private_file(output, "changed")
            self.assertEqual(output.read_text(), "FIXTURE_KEY='fixture-value'\n")
            link = Path(directory) / "fixture-link.env"
            link.symlink_to(output)
            with self.assertRaises(FileExistsError):
                env_json.write_private_file(link, "changed")

    def run_main(self, args, stdin=""):
        output = io.StringIO()
        with patch("sys.stdin", io.StringIO(stdin)), contextlib.redirect_stdout(output):
            status = env_json.main(args)
        return status, output.getvalue()

    def test_cli_validation_and_invalid_json_are_redacted(self):
        value = "fixture-secret-never-output"
        status, output = self.run_main(["validate"], json.dumps({"FIXTURE_KEY": value}))
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output)["count"], 1)
        self.assertNotIn(value, output)
        status, output = self.run_main(["validate"], '{"FIXTURE_KEY":"' + value)
        self.assertEqual(status, 2)
        self.assertNotIn(value, output)

    def test_cli_verification_exit_status_and_private_rendering(self):
        with tempfile.TemporaryDirectory() as directory:
            actual = Path(directory) / "fixture-actual.json"
            actual.write_text('{"FIXTURE_KEY":"fixture-wrong"}')
            expected = '{"FIXTURE_KEY":"fixture-expected"}'
            status, output = self.run_main(["verify", "--input", "-", "--actual", str(actual)], expected)
            self.assertEqual(status, 1)
            self.assertNotIn("fixture-expected", output)
            self.assertNotIn("fixture-wrong", output)
            actual.write_text(expected)
            status, output = self.run_main(["verify", "--input", "-", "--actual", str(actual)], expected)
            self.assertEqual(status, 0)
            private_output = Path(directory) / "fixture-private.env"
            status, output = self.run_main(["dotenv", "--output", str(private_output)], expected)
            self.assertEqual(status, 0)
            self.assertNotIn("fixture-expected", output)
            self.assertEqual(stat.S_IMODE(private_output.stat().st_mode), 0o600)
            status, output = self.run_main(["dotenv", "--output", str(private_output)], expected)
            self.assertEqual(status, 2)
            self.assertNotIn("fixture-expected", output)


if __name__ == "__main__":
    unittest.main()
