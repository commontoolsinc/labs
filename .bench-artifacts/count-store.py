#!/usr/bin/env python3
"""Count commit rows by class across every sqlite store under <srv-dir>/cache/memory.
Usage: count-store.py <srv-dir>   ->  'total=N authored=A derived=D system=S per-space: file:a/d/s ...'
"""
import glob
import os
import sqlite3
import sys


def main() -> None:
    srv = sys.argv[1]
    stores = sorted(
        glob.glob(os.path.join(srv, "cache", "memory", "**", "*.sqlite"), recursive=True)
    )
    if not stores:
        print("no-stores-found")
        return
    tot = {"authored": 0, "derived": 0, "system": 0}
    parts = []
    for s in stores:
        try:
            con = sqlite3.connect(f"file:{s}?mode=ro", uri=True)
            rows = con.execute('SELECT class, COUNT(*) FROM "commit" GROUP BY class').fetchall()
            con.close()
        except Exception as e:  # noqa: BLE001
            parts.append(f"{os.path.basename(s)}:ERR({e})")
            continue
        d = {k: v for k, v in rows}
        for k in tot:
            tot[k] += d.get(k, 0)
        parts.append(
            f"{os.path.basename(s)}:{d.get('authored', 0)}/{d.get('derived', 0)}/{d.get('system', 0)}"
        )
    total = sum(tot.values())
    print(
        f"total={total} authored={tot['authored']} derived={tot['derived']} "
        f"system={tot['system']} per-space: " + " ".join(parts)
    )


main()
