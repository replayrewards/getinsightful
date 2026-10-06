#!/usr/bin/env python3
"""Run a REAL Airbyte connector via PyAirbyte: source -> warehouse cache.

Prints exactly one JSON line on stdout at the end (progress/log chatter goes
to stderr). Exit 0 + {"status": "ok"} on success.
"""
import argparse
import json
import sys
from urllib.parse import urlparse


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj))
    sys.exit(code)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("connector", help="Airbyte connector name, e.g. source-postgres")
    p.add_argument("config", help="connector config as a JSON string")
    p.add_argument("--cache-url", default=None, help="warehouse Postgres URL")
    args = p.parse_args()

    try:
        import airbyte as ab
        from airbyte.caches import PostgresCache
    except ImportError as e:
        emit({"status": "error", "error": f"PyAirbyte missing from runner venv: {e}"}, 1)

    config = json.loads(args.config)
    url = urlparse(
        args.cache_url
        or __import__("os").environ.get("DATABASE_URL", "postgres://insightful:insightful@localhost:5437/warehouse")
    )
    cache = PostgresCache(
        host=url.hostname or "localhost",
        port=url.port or 5432,
        username=url.username or "insightful",
        password=url.password or "",
        database=(url.path or "/warehouse").lstrip("/"),
    )

    try:
        source = make_source(args.connector, config)
        # full_refresh: each sync re-lands all streams with write_strategy=replace
        # (the incremental default needs cursor bookkeeping we don't keep).
        source.select_all_streams()
        result = source.read(cache=cache, write_strategy="replace", force_full_refresh=True)
        streams = sorted(result.streams.keys()) if hasattr(result, "streams") else []
        processed = getattr(result, "processed_records", None)
        emit({
            "status": "ok",
            "connector": args.connector,
            "streams": streams,
            "processed_records": processed,
        })
    except Exception as e:  # connector failures are a normal, reported outcome
        emit({"status": "error", "error": f"{type(e).__name__}: {e}"}, 1)


def make_source(connector: str, config: dict):
    """Build + validate the source. PyAirbyte may execute connectors in Docker
    (manifest-only connectors), where 'localhost' is the container itself —
    retry once against host.docker.internal (Docker Desktop's host alias)."""
    import airbyte as ab

    try:
        source = ab.get_source(connector, install_if_missing=True, config=config)
        source.check()
        return source
    except Exception as first:
        low = str(first).lower()
        loopback = config.get("host") in ("localhost", "127.0.0.1")
        if loopback and ("08001" in low or "refused" in low):
            config = {**config, "host": "host.docker.internal"}
            source = ab.get_source(connector, install_if_missing=True, config=config)
            source.check()
            print(f"connector ran containerized; rewired host to host.docker.internal", file=sys.stderr)
            return source
        raise


if __name__ == "__main__":
    main()
