#!/usr/bin/env python3
"""Build the context store from warehouse contents.

Airbyte Agents-style pre-indexed business context: one summary entity per
synced table, plus per-entity rows for dimension tables (services), recent
incidents and alert rules — all searchable via trigram indexes and exposed to
the AI chat and the /mcp endpoint. (When Airbyte's hosted Agents SDK covers a
source, this script is where its indexer slots in.)
"""
import json
import os
import sys

import psycopg

WAREHOUSE_DSN = os.environ.get(
    "DATABASE_URL", "postgres://insightful:insightful@localhost:5437/warehouse"
)
# table -> which column holds the human-readable identity for row entities
ENTITY_COLUMNS = {
    "incidents": ("id", "title"),
    "alerts": ("id", "rule"),
    "services": ("name", "team"),
}
MAX_ROW_ENTITIES = 30
# app-internal tables never belong in the business context
APP_TABLES = {"sources", "sync_logs", "dashboards", "ctx_entities", "settings", "_sqlx_migrations"}


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj))
    sys.exit(code)


def main() -> None:
    with psycopg.connect(WAREHOUSE_DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            select schemaname, relname from pg_stat_user_tables
            where relname not like '\\_airbyte\\_%'
            order by schemaname, relname
            """
        )
        tables = [t for t in cur.fetchall() if t[1] not in APP_TABLES]

        indexed = []
        for schema, table in tables:
            qualified = f'"{schema}"."{table}"'
            cur.execute(f"select count(*) from {qualified}")
            rows = cur.fetchone()[0]
            cur.execute(
                f"""
                select column_name, data_type from information_schema.columns
                where table_schema = %s and table_name = %s
                order by ordinal_position
                """,
                (schema, table),
            )
            cols = cur.fetchall()
            col_names = [c[0] for c in cols]

            # find a timestamp column to describe coverage
            ts_col = next((c for c, t in cols if "date" in t or "time" in t), None)
            coverage = ""
            if ts_col and rows:
                cur.execute(
                    f"select min({ts_col}), max({ts_col}) from {qualified}"
                )
                lo, hi = cur.fetchone()
                coverage = f" Coverage {lo} to {hi}."

            summary = (
                f"Table {schema}.{table} with {rows} rows. "
                f"Columns: {', '.join(f'{c} {t}' for c, t in cols)}.{coverage}"
            )
            cur.execute(
                """
                insert into ctx_entities (source, collection, entity_id, title, summary, attrs)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (source, collection, entity_id) do update
                set summary = excluded.summary, attrs = excluded.attrs, indexed_at = now()
                """,
                ("warehouse", table, f"table:{table}", f"Table {table}", summary,
                 json.dumps({"rows": rows, "columns": col_names})),
            )
            indexed.append(table)

            # row-level entities for searchable business objects
            if table in ENTITY_COLUMNS and rows:
                id_col, title_col = ENTITY_COLUMNS[table]
                cur.execute(
                    f"select {id_col}::text, {title_col}::text from {qualified} limit %s",
                    (MAX_ROW_ENTITIES,),
                )
                for eid, title in cur.fetchall():
                    cur.execute(
                        """
                        insert into ctx_entities (source, collection, entity_id, title, summary, attrs)
                        values (%s, %s, %s, %s, %s, %s)
                        on conflict (source, collection, entity_id) do update
                        set title = excluded.title, indexed_at = now()
                        """,
                        ("warehouse", table, eid, title,
                         f"{table[:-1] if table.endswith('s') else table} {eid} in the GetInsightful Demo engineering dataset.",
                         json.dumps({})),
                    )

        conn.commit()
        emit({"status": "ok", "tables": indexed})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"status": "error", "error": f"{type(e).__name__}: {e}"}, 1)
