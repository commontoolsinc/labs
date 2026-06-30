import json,sys,collections
evs=json.load(open(sys.argv[1])); evs=evs['traceEvents'] if isinstance(evs,dict) else evs
tname={}
for e in evs:
    if e.get('ph')=='M' and e.get('name')=='thread_name': tname[(e['pid'],e['tid'])]=e.get('args',{}).get('name','')
# busiest thread by summed X dur
busy=collections.defaultdict(float)
for e in evs:
    if e.get('ph')=='X' and 'dur' in e: busy[(e['pid'],e['tid'])]+=e['dur']
target=max(busy,key=busy.get)
print(f"busiest thread: {tname.get(target,'?')} {target}")
# collect its X events, compute self-time via stack
te=[e for e in evs if e.get('ph')=='X' and 'dur' in e and (e['pid'],e['tid'])==target]
te.sort(key=lambda e:(e['ts'], -e['dur']))
self=collections.defaultdict(float); tot=collections.defaultdict(float); cnt=collections.defaultdict(int)
stack=[]
for e in te:
    s,d=e['ts'],e['dur']; en=s+d
    while stack and stack[-1][1]<=s: stack.pop()
    if stack: self[stack[-1][2]] -= d  # subtract from parent
    self[e['name']] += d; tot[e['name']]+=d; cnt[e['name']]+=1
    stack.append((s,en,e['name']))
total_self=sum(self.values())
span=(max(e['ts']+e['dur'] for e in te)-min(e['ts'] for e in te))/1000.0
print(f"active span: {span:.0f}ms | total self-time: {total_self/1000:.0f}ms | events: {len(te)}")
print("\n=== top by SELF-time (ms) — where the worker CPU actually goes ===")
for n,s in sorted(self.items(),key=lambda x:-x[1])[:18]:
    print(f"  self {s/1000:8.1f}ms | total {tot[n]/1000:8.1f}ms | n={cnt[n]:6d} | {n}")
# GC + microtask rollups
gc=sum(s for n,s in self.items() if 'GC' in n or 'Gc' in n or 'Sweep' in n or 'Mark' in n)
mt=sum(s for n,s in tot.items() if 'Microtask' in n)
print(f"\nGC self-time ~ {gc/1000:.0f}ms | RunMicrotasks total ~ {mt/1000:.0f}ms")
