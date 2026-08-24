#!/usr/bin/env python3
"""Analyze one run dir: W4-style settle metrics from stats-post.json (ON), or
the OFF witness (servingLoop absent). Also dumps w4-raw-style files for ON.
Usage: analyze.py <run-dir> [--dump <raw-out-dir> <prefix>]
Percentiles: nearest-rank (sorted[ceil(q*n)-1]).
"""
import json
import math
import os
import sys


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    i = max(0, math.ceil(q * len(s)) - 1)
    return s[i]


def fmt(v):
    return "-" if v is None else f"{v:.0f}"


def main() -> None:
    rundir = sys.argv[1]
    dump = None
    if len(sys.argv) > 3 and sys.argv[2] == "--dump":
        dump = (sys.argv[3], sys.argv[4])
    post = json.load(open(os.path.join(rundir, "stats-post.json")))
    pre = json.load(open(os.path.join(rundir, "stats-pre.json")))
    name = os.path.basename(rundir.rstrip("/"))
    if "servingLoop" not in post:
        print(f"[{name}] OFF witness: servingLoop_pre={'servingLoop' in pre} servingLoop_post=absent")
        return
    sl = post["servingLoop"]
    ser = sl["settle"]["series"]
    vo = [r for r in ser if r["class"] == "value-only"]
    gr = [r for r in ser if r["class"] == "structural-growth"]
    ea = [r for r in ser if r.get("eventAppend")]
    allms = [r["ms"] for r in ser]
    voms = [r["ms"] for r in vo]
    eams = [r["ms"] for r in ea]
    grcov = [r["ms"] for r in gr]
    grland = [r["msGrowth"] for r in gr if r.get("msGrowth") is not None]
    grace = [r["graceMs"] for r in gr if r.get("graceMs") is not None]
    adv = sl["settleAdvances"]
    ev = sl["events"]
    dm = sl["demand"]
    wavespi = (sum(r["waves"] for r in vo) / len(vo)) if vo else None
    landw = (sum(r.get("growthWaves", 0) for r in gr) / len(gr)) if gr else None
    authored = sl["authoredSeen"]
    derived = sl["derivedCommits"]
    acks = sl["effectAcks"]
    advn = adv["count"]
    ratio_raw = derived / (authored - acks) if authored - acks else None
    ratio_sub = (derived - advn) / (authored - acks) if authored - acks else None
    print(f"[{name}] settle: n={len(ser)} all-inputs p50/p95/max={fmt(pct(allms,.5))}/{fmt(pct(allms,.95))}/{fmt(max(allms) if allms else None)}")
    print(f"  value-only (n={len(vo)}): p50/p95/max={fmt(pct(voms,.5))}/{fmt(pct(voms,.95))}/{fmt(max(voms) if voms else None)} waves/input={wavespi:.2f}" if vo else f"  value-only: n=0")
    if gr:
        print(f"  growth (n={len(gr)}): toLanding p50/p95/max={fmt(pct(grland,.5))}/{fmt(pct(grland,.95))}/{fmt(max(grland) if grland else None)} coverage p50={fmt(pct(grcov,.5))} grace p50/p95={fmt(pct(grace,.5))}/{fmt(pct(grace,.95))} landingWaves={landw:.1f}")
    else:
        print("  growth: n=0")
    print(f"  event-append (n={len(ea)}): p50/p95={fmt(pct(eams,.5))}/{fmt(pct(eams,.95))}")
    print(f"  settleAdvances={advn} lastDelta={adv['lastDelta']} dropped={adv['dropped']} settleDropped={sl['settle']['dropped']}")
    print(f"  waves={sl['waves']} wavesBudgetExhausted={sl['wavesBudgetExhausted']} derivedCommits={derived} authoredSeen={authored} effectAcks={acks}")
    print(f"  OW37 ratio raw={ratio_raw:.2f} minusAdvances={ratio_sub:.2f}")
    print(f"  lease held={sl['lease']['held']} lost={sl['lease']['lost']}")
    print(f"  events appended={ev['appended']} processed={ev['processed']} lt1LeftoversPurged={ev['lt1LeftoversPurged']} drainInFlightSkips={ev['drainInFlightSkips']} orphanRefused={ev['orphanDeliveriesRefused']} lateSealsRefused={ev['lt1LateSealsRefused']} skippedIdempotent={ev['skippedIdempotent']}")
    print(f"  demandArrivals={sl['demandArrivals']} undemandedNarrowingRuns={sl['undemandedNarrowingRuns']} warmRequests={sl['warmRequests']} earlyEmitRefusals={sl['earlyEmitRefusals']}")
    print(f"  demand: rows={dm['demandedRows']} instances={dm['demandedInstances']}/{dm['demandedInstancesMax']} writers={dm['demandedWriters']}/{dm['demandedWritersMax']} rootEnters={dm['demandRootEnters']} rootLeaves={dm['demandRootLeaves']} notCurrentRearms={dm['notCurrentRearms']} passes={dm['demandPasses']} passMs={dm['demandPassMs']:.1f} (per-pass {dm['demandPassMs']/dm['demandPasses']:.1f}) pushGrowthWakes={dm['pushGrowthWakes']} watchWakes={dm['watchWakes']} warmWakes={dm['warmWakes']}")
    print(f"  outbox={sl['outbox']} memo={sl['memo']}")
    print(f"  walkRuns key present: {'walkRuns' in json.dumps(post)}")
    if dump:
        outdir, prefix = dump
        os.makedirs(outdir, exist_ok=True)
        json.dump({"series": ser, "dropped": sl["settle"]["dropped"]}, open(os.path.join(outdir, f"{prefix}.settle-series.json"), "w"))
        json.dump(adv, open(os.path.join(outdir, f"{prefix}.settle-advances.json"), "w"))
        json.dump(dm, open(os.path.join(outdir, f"{prefix}.demand-block.json"), "w"))


main()
