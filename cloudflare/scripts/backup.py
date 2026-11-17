"""Consistent SQLite backup + D1 data import; never reads BOT_TOKEN."""
import argparse
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

TABLES = ("users", "streaks", "achievements", "reports", "fsm")

def backup(source, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    target = output / (datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f") + ".sqlite3")
    with sqlite3.connect(f"file:{Path(source).resolve().as_posix()}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        counts = {t: dst.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in TABLES}
        statements = []
        for table in TABLES:
            for row in dst.execute(f"SELECT * FROM {table}"):
                values = [dst.execute("SELECT quote(?)", (v,)).fetchone()[0] for v in row]
                statements.append(f"INSERT INTO {table} VALUES ({','.join(values)});")
        target.with_suffix(".sql").write_text("\n".join(statements) + "\n", encoding="utf-8")
        target.with_suffix(".json").write_text(json.dumps(counts, indent=2), encoding="utf-8")
    print(json.dumps({"backup": str(target), "counts": counts}))
    return target

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("source")
    p.add_argument("--output", default="backups")
    args = p.parse_args()
    backup(args.source, args.output)
