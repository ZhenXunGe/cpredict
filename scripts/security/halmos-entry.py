#!/usr/bin/env python3
"""Run Halmos with its solver cache isolated inside the repository tool directory."""

from pathlib import Path


PROJECT_TOOL_HOME = Path(__file__).resolve().parents[2] / ".tools" / "halmos-home"
PROJECT_TOOL_HOME.mkdir(parents=True, exist_ok=True)

# Halmos 0.3.3 resolves its solver cache from Path.home() at import time and does not expose a
# cache-directory option. Redirect only this isolated process; do not change HOME or user config.
Path.home = classmethod(lambda cls: PROJECT_TOOL_HOME)  # type: ignore[method-assign]

from halmos.__main__ import main  # noqa: E402


if __name__ == "__main__":
    main()
