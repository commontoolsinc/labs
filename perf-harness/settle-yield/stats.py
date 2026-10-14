"""stats.py <out-dir> : the derived numbers the report needs beyond what the
harness tables print."""
import json, re, statistics as st, sys
out = sys.argv[1]
T23 = 2.069  # two-sided 95% t quantile, 23 degrees of freedom
T7 = 2.365   # 7 degrees of freedom

def summ(label):
    d = json.load(open(f"{out}/{label}.load1.summary.json"))
    steps = {r["label"]: r["ms"] for r in d["steps"]}
    worker = {r["key"]: r for r in d["summary"]["worker"]}
    ipc = {r["key"]: r for r in d["summary"]["ipc"]}
    g = lambda s: next((r for k, r in worker.items() if k.endswith(s)), {"count": 0, "max": 0, "total": 0})
    cell = [r for k, r in ipc.items() if k.startswith("ipc/cell:")]
    calls = sum(r["count"] for r in cell) or 1
    return dict(msgs=steps["last message visible"] / 1000, settled=steps["view settled"] / 1000,
                settle=g("execute/settle")["max"] / 1000, yT=g("execute/yield")["total"] / 1000,
                yN=g("execute/yield")["count"], cellAvg=sum(r["total"] for r in cell) / calls)

def paired(name, d, t):
    n = len(d); se = st.stdev(d) / n ** 0.5; m = st.mean(d)
    print(f"{name}: n {n} mean {m:+.2f} median {st.median(d):+.2f} se {se:.2f} 95% CI [{m - t*se:+.2f}, {m + t*se:+.2f}]"
          f" a higher {sum(x > 0 for x in d)}/{n}; largest |diff| ruled out {max(abs(m - t*se), abs(m + t*se)):.2f}")

P = [(summ(f"w{i}-a"), summ(f"w{i}-b")) for i in range(1, 25)]
print("== browser, 24 pairs")
for k in ["msgs", "settled"]:
    print(f"  {k}: a mean {st.mean(a[k] for a,_ in P):.2f} b mean {st.mean(b[k] for _,b in P):.2f}")
    paired("  " + k, [a[k] - b[k] for a, b in P], T23)
paired("  total", [a["msgs"] + a["settled"] - b["msgs"] - b["settled"] for a, b in P], T23)
paired("  settle", [a["settle"] - b["settle"] for a, b in P], T23)
paired("  settle(a) - yT(a) vs settle(b)", [a["settle"] - a["yT"] - b["settle"] for a, b in P], T23)
print(f"  settle-yT a mean {st.mean(a['settle'] - a['yT'] for a,_ in P):.2f}, b settle mean {st.mean(b['settle'] for _,b in P):.2f}")
print(f"  yN a mean {st.mean(a['yN'] for a,_ in P):.0f} median {st.median(a['yN'] for a,_ in P):.0f} range {min(a['yN'] for a,_ in P)}-{max(a['yN'] for a,_ in P)};"
      f" yT mean {st.mean(a['yT'] for a,_ in P):.2f} median {st.median(a['yT'] for a,_ in P):.2f} range {min(a['yT'] for a,_ in P):.2f}-{max(a['yT'] for a,_ in P):.2f}")
for arm, ix in (("a", 0), ("b", 1)):
    v = sorted(p[ix]["cellAvg"] for p in P)
    slow = [i + 1 for i, p in enumerate(P) if p[ix]["cellAvg"] > 450]
    print(f"  cellAvg {arm}: fast {24 - len(slow)} slow {len(slow)} (pairs {slow});"
          f" fast mean {st.mean(x for x in v if x <= 450):.0f} ms, slow mean {st.mean(x for x in v if x > 450):.0f} ms; sorted {[round(x) for x in v]}")
sl = [i + 1 for i, (a, _) in enumerate(P) if a["cellAvg"] > 450]
print(f"  arm a slow loads: yT {[round(P[i-1][0]['yT'],1) for i in sl]}, msgs {[round(P[i-1][0]['msgs'],1) for i in sl]};"
      f" fast-load msgs mean a {st.mean(a['msgs'] for a,_ in P if a['cellAvg'] <= 450):.2f}, slow-load msgs mean a {st.mean(a['msgs'] for a,_ in P if a['cellAvg'] > 450):.2f}")

print("== deno reloads r1-r8")
def cpu(label):
    m = re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys', open(f'{out}/{label}.err').read())
    return [float(x) for x in m.groups()]
R = [(cpu(f"r{i}-a"), cpu(f"r{i}-b")) for i in range(1, 9)]
print(f"  wall a mean {st.mean(a[0] for a,_ in R):.1f} b mean {st.mean(b[0] for _,b in R):.1f}")
paired("  wall", [a[0] - b[0] for a, b in R], T7)
print(f"  cpu(user+sys) a mean {st.mean(a[1]+a[2] for a,_ in R):.1f} b mean {st.mean(b[1]+b[2] for _,b in R):.1f}")
paired("  cpu", [a[1] + a[2] - b[1] - b[2] for a, b in R], T7)
