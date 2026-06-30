import json,sys,collections
evs=json.load(open(sys.argv[1])); evs=evs['traceEvents'] if isinstance(evs,dict) else evs
prof=collections.defaultdict(lambda:{'cf':{},'par':{},'samples':[],'deltas':[]})
for e in evs:
    nm=e.get('name')
    if nm in ('Profile','ProfileChunk'):
        k=(e['pid'],e['tid']); data=e.get('args',{}).get('data',{}); cp=data.get('cpuProfile',{}) if nm=='ProfileChunk' else data
        for n in (cp.get('nodes') or []):
            prof[k]['cf'][n['id']]=n.get('callFrame',{})
            if 'parent' in n: prof[k]['par'][n['id']]=n['parent']
        prof[k]['samples'] += (cp.get('samples') or []); prof[k]['deltas'] += (data.get('timeDeltas') or cp.get('timeDeltas') or [])
def rtms(p): return sum((p['deltas'][i] if i<len(p['deltas']) else 0) for i,s in enumerate(p['samples']) if 'worker-runtime' in (p['cf'].get(s,{}).get('url') or ''))
target=max(prof,key=lambda k:rtms(prof[k])); p=prof[target]; cf=p['cf']; par=p['par']
fn=lambda i:(cf.get(i,{}).get('functionName') or '(anon)')
selfn=collections.defaultdict(float)
for i,s in enumerate(p['samples']): selfn[s]+=(p['deltas'][i] if i<len(p['deltas']) else 0)
# inclusive by function via parent walk
agg=collections.defaultdict(float)
for nid,sv in selfn.items():
    seen=set(); a=nid
    while a is not None:
        f=fn(a)
        if f not in seen: agg[f]+=sv; seen.add(f)
        a=par.get(a)
IGN={'(idle)','(program)','(root)','(garbage collector)'}
print("=== INCLUSIVE ms by function (top, excl idle/program) ===")
for f,d in sorted(agg.items(),key=lambda x:-x[1]):
    if f in IGN: continue
    print(f"  {d/1000:7.1f}ms  {f[:50]}")
    if d/1000<6: break
def paths(funcname,topn=4):
    hits=sorted([(i,selfn[i]) for i in selfn if fn(i)==funcname and selfn[i]>0],key=lambda x:-x[1])
    print(f"\n=== callers of `{funcname}` (self {sum(h[1] for h in hits)/1000:.0f}ms) ===")
    for nid,sv in hits[:topn]:
        chain=[]; a=par.get(nid)
        while a is not None and len(chain)<9:
            f=fn(a)
            if f not in ('(anon)',) or not chain: chain.append(f)
            a=par.get(a)
        print(f"  [{sv/1000:.1f}ms] <- "+" <- ".join(chain))
for t in ['getLineAndColumnAtOffset','baseFreezeAndTraverse','recursiveStripAsCellFromSchema','randomIntInRange','__copyProps']: paths(t)
