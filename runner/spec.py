#!/usr/bin/env python3
"""Print a connector's config spec as one JSON line: {"connector": ..., "spec": ...}."""
import argparse
import json
import sys


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj))
    sys.exit(code)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("connector")
    args = p.parse_args()
    try:
        import airbyte as ab

        source = ab.get_source(args.connector, install_if_missing=True)
        spec = getattr(source, "connector_spec", None) or getattr(
            getattr(source, "connector", None), "connector_spec", None
        )
        if spec is None:
            # degrades the UI to a raw-config textarea rather than failing
            spec = {"properties": {}, "type": "object"}
        emit({"connector": args.connector, "spec": json.loads(json.dumps(spec))})
    except Exception as e:
        emit({"status": "error", "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
