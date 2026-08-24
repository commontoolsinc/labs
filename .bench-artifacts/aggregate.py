#!/usr/bin/env python3
"""Aggregate the topics campaign's run dirs into the report's three series.

Usage: aggregate.py <runs-dir> [run-glob-prefixes...]
Reads each run dir's test.log (+ stats-post.json via analyze-style parsing)
and the ledger lines are NOT needed: wall/rc come from junit.xml presence and
the driver's ledger stays the authority for posture/loads.

Emits, as markdown-ish text:
  - M1 table: per-run test wall (from ledger passed on stdin? no: reads
    run-ledger.txt beside runs-dir) and rc per arm + per-arm stats.
  - M2 journey: per-arm per-step p50/p90 (n=runs) + pooled series
    echo/arrival/gap p50/p90 (n=runs*20).
  - Settle series: per ON run all-inputs/value-only/growth/event-append
    p50/p95/max pooled and per-run.
Percentiles nearest-rank (sorted[ceil(q*n)-1]), the dossier's convention.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return s[max(0, math.ceil(q * len(s)) - 1)]


def fmt(v, nd=0):
    if v is None:
        return "-"
    return f"{v:.{nd}f}"


STEP_RE = re.compile(r"^\s+(\d+)ms\s+(.+?)\s*$")
SERIES_RE = re.compile(r"^\[topics-series\] per-event (echo|arrival|gap) ms: (.*)$")
SEED_RE = re.compile(r"^\[topics-journey\] arm=(ON|OFF) seed echo ms: (.*)$")
TOTAL_RE = re.compile(r"^\[topics-journey (ON|OFF)\] step timings \(total (\d+)ms\):")


def parse_ledger(ledger_path):
    """run-id -> dict(arm, wall_s, rc, drops, txerr, define, serving)."""
    out = {}
    cur = None
    for line in open(ledger_path):
        line = line.rstrip("\n")
        if line.startswith("== "):
            cur = line[3:].strip()
            out[cur] = {}
        elif cur is None:
            continue
        elif line.startswith("start_utc="):
            m = re.search(r"arm=(\S+)", line)
            if m:
                out[cur]["arm"] = m.group(1)
        elif line.startswith("test_rc="):
            m = re.match(r"test_rc=(\d+) test_wall_s=(\d+)", line)
            if m:
                out[cur]["rc"] = int(m.group(1))
                out[cur]["wall_s"] = int(m.group(2))
        elif line.startswith("echo_drop_guard_lines="):
            out[cur]["drops"] = int(line.split("=")[1])
        elif line.startswith("tx_commit_error_lines="):
            out[cur]["txerr"] = int(line.split("=")[1])
        elif "posture:" in line:
            m = re.search(r"define=(\S+) servingLoop_pre=(\S+)", line)
            if m:
                out[cur]["define"] = m.group(1)
                out[cur]["serving"] = m.group(2)
        elif line.startswith("store_commits:"):
            m = re.search(r"total=(\d+) authored=(\d+) derived=(\d+)", line)
            if m:
                out[cur]["store"] = (
                    int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return out


def parse_journey_log(path):
    steps = {}
    series = {}
    seeds = []
    total = None
    for line in open(path, errors="replace"):
        line = re.sub(r"\x1b\[[0-9;]*m", "", line.rstrip("\n"))
        m = SEED_RE.match(line)
        if m:
            seeds = [float(x) for x in m.group(2).split()]
            continue
        m = SERIES_RE.match(line)
        if m:
            series[m.group(1)] = [float(x) for x in m.group(2).split()]
            continue
        m = TOTAL_RE.match(line)
        if m:
            total = float(m.group(2))
            continue
        m = STEP_RE.match(line)
        if m and total is not None:
            steps[m.group(2)] = float(m.group(1))
    return {"steps": steps, "series": series, "seeds": seeds, "total": total}


def settle_from_stats(path):
    post = json.load(open(path))
    if "servingLoop" not in post:
        return None
    sl = post["servingLoop"]
    ser = sl["settle"]["series"]
    return {
        "series": ser,
        "advances": sl.get("settleAdvances", {}),
        "authored": sl.get("authoredSeen"),
        "derived": sl.get("derivedCommits"),
        "acks": sl.get("effectAcks"),
        "waves": sl.get("waves"),
        "budgetExhausted": sl.get("wavesBudgetExhausted"),
        "events": sl.get("events", {}),
        "lease": sl.get("lease", {}),
    }


def series_stats(vals):
    return (fmt(pct(vals, .5)), fmt(pct(vals, .9)), fmt(pct(vals, .95)),
            fmt(min(vals)) if vals else "-", fmt(max(vals)) if vals else "-")


def main():
    runsdir = sys.argv[1]
    ledger = parse_ledger(os.path.join(os.path.dirname(runsdir.rstrip("/")), "run-ledger.txt"))
    runs = sorted(os.listdir(runsdir))

    # ---- M1: test workload
    m1 = {"on": [], "off": []}
    for r in runs:
        if not r.startswith("t"):
            continue
        info = ledger.get(r, {})
        if "arm" in info:
            m1[info["arm"]].append((r, info))
    print("## M1 — topics-navigation.test.ts (pass/fail + wall clock)\n")
    print("| run | arm | rc | wall_s | txerr | drops | store a/d |")
    print("|---|---|---|---|---|---|---|")
    for arm in ("off", "on"):
        for r, info in m1[arm]:
            st = info.get("store", ("?", "?", "?"))
            print(f"| {r} | {arm.upper()} | {info.get('rc')} | {info.get('wall_s')} | "
                  f"{info.get('txerr', '-')} | {info.get('drops', '-')} | {st[1]}/{st[2]} |")
    for arm in ("off", "on"):
        walls = [i.get("wall_s") for _, i in m1[arm] if i.get("rc") == 0]
        alln = len(m1[arm])
        if walls:
            print(f"\n{arm.upper()}: n={alln} green={len(walls)} "
                  f"wall median={fmt(pct(walls,.5))}s min={min(walls)}s max={max(walls)}s")

    # ---- M2: journey
    m2 = {"on": [], "off": []}
    for r in runs:
        if not r.startswith("j"):
            continue
        info = ledger.get(r, {})
        log = os.path.join(runsdir, r, "test.log")
        if "arm" in info and os.path.exists(log):
            m2[info["arm"]].append((r, info, parse_journey_log(log)))
    print("\n## M2 — topics journey benchmark (n per arm = runs)\n")
    step_names = [
        "board create + start (controller)",
        "addTopic seed 1 echo (controller)",
        "addTopic seed 2 echo (controller)",
        "fid capture (result.pull + resolveAsCell x2)",
        "browser cold load: goto + login",
        "browser runtime idle",
        "browser renders both seed titles",
        "navigate-to-topic: click Open -> piece view",
        "post-navigation runtime idle",
    ]
    print("| step (ms) | OFF p50/p90 (min-max) | ON p50/p90 (min-max) |")
    print("|---|---|---|")
    for sn in step_names + ["TOTAL journey"]:
        cells = []
        for arm in ("off", "on"):
            if sn == "TOTAL journey":
                vals = [j["total"] for _, _, j in m2[arm] if j["total"] is not None]
            else:
                vals = [j["steps"][sn] for _, _, j in m2[arm] if sn in j["steps"]]
            if vals:
                cells.append(f"{fmt(pct(vals,.5))} / {fmt(pct(vals,.9))} "
                             f"({fmt(min(vals))}-{fmt(max(vals))}) n={len(vals)}")
            else:
                cells.append("-")
        print(f"| {sn} | {cells[0]} | {cells[1]} |")
    print("\n**Pooled per-event series (echo=controller's own render analog; "
          "arrival=other surface's browser render; gap=arrival-echo):**\n")
    print("| series (ms) | arm | n | p50 | p90 | p95 | min | max |")
    print("|---|---|---|---|---|---|---|---|")
    for kind in ("echo", "arrival", "gap"):
        for arm in ("off", "on"):
            pool = []
            for _, _, j in m2[arm]:
                pool.extend(j["series"].get(kind, []))
            if pool:
                p50, p90, p95, mn, mx = series_stats(pool)
                print(f"| {kind} | {arm.upper()} | {len(pool)} | {p50} | {p90} | {p95} | {mn} | {mx} |")
    print("\nPer-run medians (echo->arrival), for variance:")
    for arm in ("off", "on"):
        meds = []
        for r, _, j in m2[arm]:
            e = j["series"].get("echo", [])
            a = j["series"].get("arrival", [])
            if e and a:
                meds.append(f"{r}:{fmt(pct(e,.5))}->{fmt(pct(a,.5))}")
        print(f"  {arm.upper()}: " + " ".join(meds))
    for arm in ("off", "on"):
        seeds1 = [j["seeds"][0] for _, _, j in m2[arm] if j["seeds"]]
        seeds2 = [j["seeds"][1] for _, _, j in m2[arm] if len(j["seeds"]) > 1]
        if seeds1:
            print(f"  seed-echo {arm.upper()}: seed1 p50={fmt(pct(seeds1,.5))} "
                  f"max={fmt(max(seeds1))}; seed2 p50={fmt(pct(seeds2,.5))} max={fmt(max(seeds2))}")

    # ---- Settle series (ON runs; OFF witness = servingLoop absent)
    print("\n## Server settle-time series (OW38(ii)) — ON runs\n")
    print("| run | n | ALL-INPUTS p50/p95/max | value-only p50/p95/max (n) | "
          "growth n; toLanding p50/p95/max; coverage p50 | event-append p50/p95 (n) | "
          "advances | derived/authored/acks |")
    print("|---|---|---|---|---|---|---|---|")
    pooled_all, pooled_vo, pooled_land, pooled_cov = [], [], [], []
    off_witness = []
    for r in runs:
        if not (r.startswith("j") or r.startswith("t")):
            continue
        sp = os.path.join(runsdir, r, "stats-post.json")
        if not os.path.exists(sp):
            continue
        s = settle_from_stats(sp)
        arm = ledger.get(r, {}).get("arm")
        if s is None:
            if arm == "on":
                off_witness.append(f"{r}: ON RUN WITHOUT servingLoop (POSTURE BREAK)")
            continue
        if arm == "off":
            off_witness.append(f"{r}: OFF RUN WITH servingLoop (POSTURE BREAK)")
            continue
        ser = s["series"]
        allms = [x["ms"] for x in ser]
        vo = [x["ms"] for x in ser if x["class"] == "value-only"]
        gr = [x for x in ser if x["class"] == "structural-growth"]
        grland = [x["msGrowth"] for x in gr if x.get("msGrowth") is not None]
        grcov = [x["ms"] for x in gr]
        ea = [x["ms"] for x in ser if x.get("eventAppend")]
        pooled_all.extend(allms)
        pooled_vo.extend(vo)
        pooled_land.extend(grland)
        pooled_cov.extend(grcov)
        adv = s["advances"]
        print(f"| {r} | {len(ser)} | "
              f"{fmt(pct(allms,.5))}/{fmt(pct(allms,.95))}/{fmt(max(allms)) if allms else '-'} | "
              f"{fmt(pct(vo,.5))}/{fmt(pct(vo,.95))}/{fmt(max(vo)) if vo else '-'} ({len(vo)}) | "
              f"{len(gr)}; {fmt(pct(grland,.5))}/{fmt(pct(grland,.95))}/{fmt(max(grland)) if grland else '-'}; {fmt(pct(grcov,.5))} | "
              f"{fmt(pct(ea,.5))}/{fmt(pct(ea,.95))} ({len(ea)}) | "
              f"{adv.get('count')} (d={adv.get('dropped')}) | "
              f"{s['derived']}/{s['authored']}/{s['acks']} |")
    if pooled_all:
        print(f"\nPOOLED ON: all-inputs n={len(pooled_all)} "
              f"p50={fmt(pct(pooled_all,.5))} p90={fmt(pct(pooled_all,.9))} "
              f"p95={fmt(pct(pooled_all,.95))} max={fmt(max(pooled_all))}; "
              f"value-only n={len(pooled_vo)} p50={fmt(pct(pooled_vo,.5))} "
              f"p95={fmt(pct(pooled_vo,.95))}; "
              f"growth-to-landing n={len(pooled_land)} p50={fmt(pct(pooled_land,.5))} "
              f"p95={fmt(pct(pooled_land,.95))} max={fmt(max(pooled_land)) if pooled_land else '-'}; "
              f"growth-coverage p50={fmt(pct(pooled_cov,.5))}")
    if off_witness:
        print("\nPOSTURE BREAKS: " + "; ".join(off_witness))
    else:
        print("\nOFF witness: every OFF run's stats-post lacks servingLoop; "
              "every ON run carries it (no posture breaks).")


main()
