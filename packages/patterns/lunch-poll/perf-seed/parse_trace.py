import json, sys, collections
path=sys.argv[1]
data=json.load(open(path))
evs=data['traceEvents'] if isinstance(data,dict) else data
# thread names
tname={}
for e in evs:
    if e.get('ph')=='M' and e.get('name')=='thread_name':
        tname[(e['pid'],e['tid'])]=e.get('args',{}).get('name','')
# per-thread aggregate of complete 'X' events
busy=collections.defaultdict(float); span=collections.defaultdict(lambda:[float('inf'),0]); cnt=collections.defaultdict(int)
namedur=collections.defaultdict(lambda:collections.defaultdict(float))
for e in evs:
    if e.get('ph')=='X' and 'dur' in e:
        key=(e['pid'],e['tid']); d=e['dur']/1000.0  # ms
        busy[key]+=d; cnt[key]+=1
        ts=e['ts']/1000.0
        span[key][0]=min(span[key][0],ts); span[key][1]=max(span[key][1],ts+d)
        namedur[key][e['name']]+=d
def label(k): return f"{tname.get(k,'?')} (pid{k[0]}/tid{k[1]})"
# rank threads by busy (sum of X durs — over-counts nesting but ok for ranking)
rows=sorted(busy.items(),key=lambda kv:-kv[1])[:8]
print("=== top threads by summed slice time (ms) — note: sums nested slices ===")
for k,b in rows:
    sp=span[k]; active=sp[1]-sp[0] if sp[1] else 0
    print(f"  {b:9.0f}ms slices | {active:8.0f}ms active-span | {cnt[k]:6d} ev | {label(k)}")
# focus worker threads
print("\n=== worker thread(s): top event names by total dur (ms) ===")
for k,b in busy.items():
    nm=tname.get(k,'')
    if 'Worker' in nm or 'worker' in nm or 'DedicatedWorker' in nm:
        print(f"-- {label(k)}: span {span[k][1]-span[k][0]:.0f}ms, {cnt[k]} events --")
        top=sorted(namedur[k].items(),key=lambda x:-x[1])[:12]
        for n,d in top: print(f"     {d:8.1f}ms  {n}")
