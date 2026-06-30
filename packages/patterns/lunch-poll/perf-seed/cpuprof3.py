import json,sys,collections
evs=json.load(open(sys.argv[1])); evs=evs['traceEvents'] if isinstance(evs,dict) else evs
prof=collections.defaultdict(lambda:{'nodes':{},'children':collections.defaultdict(list),'samples':[],'deltas':[]})
for e in evs:
    nm=e.get('name')
    if nm in ('Profile','ProfileChunk'):
        k=(e['pid'],e['tid']); data=e.get('args',{}).get('data',{})
        cp=data.get('cpuProfile',{}) if nm=='ProfileChunk' else data
        for n in (cp.get('nodes') or []):
            prof[k]['nodes'][n['id']]=n.get('callFrame',{})
            if n.get('children'): prof[k]['children'][n['id']]=n['children']
        prof[k]['samples'] += (cp.get('samples') or [])
        prof[k]['deltas'] += (data.get('timeDeltas') or cp.get('timeDeltas') or [])
# pick worker isolate = most self-time in worker-runtime.js
def runtime_ms(p):
    tot=0
    for i,s in enumerate(p['samples']):
        cf=p['nodes'].get(s); 
        if cf and 'worker-runtime' in (cf.get('url') or ''): tot+=p['deltas'][i] if i<len(p['deltas']) else 0
    return tot
target=max(prof, key=lambda k: runtime_ms(prof[k]))
p=prof[target]; nodes=p['nodes']; children=p['children']
# self per node
selfn=collections.defaultdict(float)
for i,s in enumerate(p['samples']):
    selfn[s]+= (p['deltas'][i] if i<len(p['deltas']) else 0)
# parent map
parent={}
for pid,ch in children.items():
    for c in ch: parent[c]=pid
# inclusive per node (self + descendants) via memo
import sys as _s; _s.setrecursionlimit(100000)
incl={}
def inc(nid):
    if nid in incl: return incl[nid]
    t=selfn.get(nid,0)
    for c in children.get(nid,[]): t+=inc(c)
    incl[nid]=t; return t
for nid in list(nodes): inc(nid)
# aggregate inclusive by function (dedup per stack: only count a node's inclusive if its function not already an ancestor — to avoid recursion double count; approximate by counting top-most occurrence)
def fname(nid):
    cf=nodes.get(nid,{}); return cf.get('functionName') or '(anon)'
agg=collections.defaultdict(float); seen_on_path=collections.defaultdict(float)
# top-most occurrence inclusive: a node counts if no ancestor has same function name
for nid in nodes:
    fn=fname(nid); a=parent.get(nid); dup=False
    while a is not None:
        if fname(a)==fn: dup=True; break
        a=parent.get(a)
    if not dup: agg[fn]+=incl.get(nid,0)
print(f"=== worker isolate {target} — INCLUSIVE time by function (top, dedup recursion) ===")
for fn,d in sorted(agg.items(),key=lambda x:-x[1])[:20]:
    print(f"  {d/1000:7.1f}ms  {fn[:50]}")
# call paths to a target function
def paths_to(funcname, topn=3):
    hits=[(nid,selfn.get(nid,0)) for nid in nodes if fname(nid)==funcname and selfn.get(nid,0)>0]
    hits.sort(key=lambda x:-x[1])
    print(f"\n=== heaviest call paths to `{funcname}` (self {sum(h[1] for h in hits)/1000:.0f}ms across {len(hits)} nodes) ===")
    for nid,sv in hits[:topn]:
        chain=[]; a=nid; 
        while a is not None and len(chain)<10:
            chain.append(fname(a)); a=parent.get(a)
        print(f"  [{sv/1000:.1f}ms] "+" <- ".join(chain))
paths_to('getLineAndColumnAtOffset')
paths_to('baseFreezeAndTraverse')
paths_to('randomIntInRange')
