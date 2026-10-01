#!/usr/bin/env python3
"""Offline ENV validation, dotenv rendering, comparison, and UI authorization."""

import argparse
import json
import os
from pathlib import Path
import re
import sys


class EnvError(ValueError):
    """A safe diagnostic that never includes an environment value."""


NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*", re.ASCII)
WORKSPACE = re.compile(r"[A-Za-z0-9_-]{1,128}", re.ASCII)
PROJECT = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", re.ASCII)


def require_ui_mutation(workspace, project, observed_workspace, observed_project, confirm):
    """Check local authorization only; never contacts or mutates Hoplite."""
    if not WORKSPACE.fullmatch(workspace) or not PROJECT.fullmatch(project):
        raise EnvError("A workspace ID and repository-qualified project are required")
    if any(part in {".", ".."} for part in project.split("/")):
        raise EnvError("A repository-qualified project is required")
    if (workspace, project) != (observed_workspace, observed_project):
        raise EnvError("The observed destination does not match the intended workspace/project")
    target = f"project-env:{workspace}:{project}"
    raw_allowlist = os.environ.get("HOPLITE_MUTATION_ALLOWLIST", "")
    allowlist = set(filter(None, re.split(r"[\s,]+", raw_allowlist)))
    if target not in allowlist:
        raise EnvError("The exact project-env target is not in HOPLITE_MUTATION_ALLOWLIST")
    if not confirm:
        raise EnvError("UI environment mutations require --confirm")
    return {"ok": True, "mutation_gate_passed": True, "target": target}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EnvError("Duplicate JSON key; import refused")
        result[key] = value
    return result


def parse_environment(text):
    try:
        data = json.loads(text, object_pairs_hook=unique_object)
    except json.JSONDecodeError:
        raise EnvError("Invalid JSON; import refused") from None
    except (RecursionError, UnicodeError):
        raise EnvError("Unreadable JSON; import refused") from None
    if not isinstance(data, dict):
        raise EnvError("Expected a JSON object of environment names and strings")
    for key, value in data.items():
        if not NAME.fullmatch(key):
            raise EnvError("Invalid environment name; import refused")
        if not isinstance(value, str):
            raise EnvError("Every environment value must be a string")
        if "\x00" in value:
            raise EnvError("Environment values cannot contain NUL characters")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise EnvError("Environment values must be valid UTF-8 strings") from None
    return data


def render_dotenv(environment):
    unsupported = [
        key for key, value in environment.items()
        if any(character in value for character in "'\r\n")
    ]
    if unsupported:
        raise EnvError(
            "Use individual Key/Value fields for: " + ", ".join(unsupported)
        )
    lines = [f"{key}='{value}'" for key, value in environment.items()]
    return "\n".join(lines) + ("\n" if lines else "")


def compare_environment(expected, actual):
    missing = sorted(expected.keys() - actual.keys())
    mismatched = sorted(
        key for key in expected.keys() & actual.keys()
        if expected[key] != actual[key]
    )
    return {
        "ok": not missing and not mismatched,
        "expected_count": len(expected),
        "matched_count": len(expected) - len(missing) - len(mismatched),
        "missing_keys": missing,
        "mismatched_keys": mismatched,
        "additional_keys": sorted(actual.keys() - expected.keys()),
    }


def write_private_file(path, content):
    # O_EXCL also prevents following an existing symlink or replacing a file.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise


def read_environment(path):
    try:
        text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise EnvError("Cannot read the supplied JSON input") from None
    return parse_environment(text)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="Print names and count only")
    validate.add_argument("--input", default="-", help="JSON path, or - for stdin")
    dotenv = commands.add_parser("dotenv", help="Create a new owner-only dotenv file")
    dotenv.add_argument("--input", default="-")
    dotenv.add_argument("--output", required=True, help="New private file; never overwritten")
    verify = commands.add_parser("verify", help="Compare imported keys and exact values")
    verify.add_argument("--input", required=True, help="Expected JSON path, or - for stdin")
    verify.add_argument("--actual", required=True, help="Destination JSON readback path")
    guard = commands.add_parser("guard-ui", help="Check exact project authorization; performs no import")
    guard.add_argument("--workspace", required=True, help="Intended workspace ID")
    guard.add_argument("--project", required=True, help="Intended owner/repository")
    guard.add_argument("--observed-workspace", required=True, help="Workspace ID from fresh destination state")
    guard.add_argument("--observed-project", required=True, help="Owner/repository from fresh destination state")
    guard.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "guard-ui":
            receipt = require_ui_mutation(
                args.workspace, args.project, args.observed_workspace, args.observed_project, args.confirm
            )
            print(json.dumps(receipt, ensure_ascii=True))
            return 0
        expected = read_environment(args.input)
        if args.command == "verify":
            if args.actual == "-":
                raise EnvError("Destination readback must be a file, not shared stdin")
            receipt = compare_environment(expected, read_environment(args.actual))
            status = 0 if receipt["ok"] else 1
        elif args.command == "dotenv":
            content = render_dotenv(expected)
            write_private_file(args.output, content)
            receipt = {"ok": True, "count": len(expected), "private_file_created": True}
            status = 0
        else:
            receipt = {"ok": True, "count": len(expected), "keys": list(expected)}
            status = 0
    except EnvError as error:
        receipt, status = {"ok": False, "error": str(error)}, 2
    except OSError:
        # Do not echo arbitrary file paths, source contents, or OS diagnostics.
        receipt, status = {"ok": False, "error": "Cannot create a new private output file"}, 2
    print(json.dumps(receipt, ensure_ascii=True))
    return status


if __name__ == "__main__":
    sys.exit(main())
