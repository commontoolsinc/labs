"""browser-table.py <out-dir> <prefix> <from> <to> : every browser pair, then
paired statistics over them. Seconds unless marked."""
import json, statistics as st, sys
out, prefix, lo, hi = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

def load(label):
    d = json.load(open(f"{out}/{label}.load1.summary.json"))
    steps = {r["label"]: r["ms"] for r in d["steps"]}
    worker = {r["key"]: r for r in d["summary"]["worker"]}
    ipc = {r["key"]: r for r in d["summary"]["ipc"]}
    def g(suffix):
        for key, row in worker.items():
            if key.endswith(suffix):
                return row
        return {"count": 0, "max": 0, "total": 0}
    cell = [r for k, r in ipc.items() if k.startswith("ipc/cell:")]
    calls = sum(r["count"] for r in cell) or 1
    y = g("execute/yield")
    return dict(
        msgs=steps["last message visible"] / 1000,
        settled=steps["view settled"] / 1000,
        total=(steps["last message visible"] + steps["view settled"]) / 1000,
        settle=g("execute/settle")["max"] / 1000,
        runT=g("scheduler/run")["total"] / 1000,
        runs=g("scheduler/run")["count"],
        wadd=g("watchAddSync")["max"] / 1000,
        yN=y["count"], yT=y["total"] / 1000,
        cellAvgMs=sum(r["total"] for r in cell) / calls,
        cellMaxMs=max((r["max"] for r in cell), default=0),
        load=open(f"{out}/{label}.load").read().split()[0],
    )

pairs = [(load(f"{prefix}{i}-a"), load(f"{prefix}{i}-b")) for i in range(lo, hi + 1)]
keys = ["msgs", "settled", "total", "settle", "runT", "runs", "wadd", "yN", "yT", "cellAvgMs", "cellMaxMs", "load"]
print("\t".join(["pair", "arm"] + keys))
for i, (a, b) in enumerate(pairs, lo):
    for arm, row in (("a", a), ("b", b)):
        print("\t".join([str(i), arm] + [f"{row[k]:.1f}" if isinstance(row[k], float) else str(row[k]) for k in keys]))
print()
n = len(pairs)
for key in ["msgs", "settled", "total", "settle", "runT", "wadd", "cellAvgMs", "cellMaxMs"]:
    d = [a[key] - b[key] for a, b in pairs]
    se = st.stdev(d) / n ** 0.5 if n > 1 else 0
    print(f"{key:10s} a mean {st.mean(a[key] for a, _ in pairs):9.2f}  b mean {st.mean(b[key] for _, b in pairs):9.2f}"
          f"  a-b mean {st.mean(d):+8.2f} median {st.median(d):+8.2f} se {se:6.2f}"
          f"  a higher in {sum(1 for x in d if x > 0)}/{n}, lower in {sum(1 for x in d if x < 0)}/{n}")
print(f"turns per load (a): mean {st.mean(a['yN'] for a, _ in pairs):.0f}; turn time per load: mean {st.mean(a['yT'] for a, _ in pairs):.2f} median {st.median(a['yT'] for a, _ in pairs):.2f}")
