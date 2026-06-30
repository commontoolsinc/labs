import json,sys,collections
evs=json.load(open(sys.argv[1])); evs=evs['traceEvents'] if isinstance(evs,dict) else evs
prof=collections.defaultdict(lambda:{'nodes':{},'samples':[],'deltas':[]})
for e in evs:
    nm=e.get('name')
    if nm in ('Profile','ProfileChunk'):
        k=(e['pid'],e['tid']); data=e.get('args',{}).get('data',{})
        cp=data.get('cpuProfile',{}) if nm=='ProfileChunk' else data
        for n in (cp.get('nodes') or []): prof[k]['nodes'][n['id']]=n.get('callFrame',{})
        prof[k]['samples'] += (cp.get('samples') or [])
        prof[k]['deltas'] += (data.get('timeDeltas') or cp.get('timeDeltas') or [])
IDLE={'(idle)','(program)','(root)','(garbage collector)'}
for idx,(k,p) in enumerate(sorted(prof.items(), key=lambda kv:-sum(kv[1]['deltas']))):
    if not p['samples']: continue
    nodes=p['nodes']; selfn=collections.defaultdict(float); byfile=collections.defaultdict(float); busy=0; idle=0
    for i,s in enumerate(p['samples']):
        d=p['deltas'][i] if i<len(p['deltas']) else 0
        cf=nodes.get(s)
        if not cf: continue
        fn=cf.get('functionName') or '(anonymous)'; url=cf.get('url') or ''
        if fn in IDLE: idle+=d; continue
        busy+=d
        f=url.split('/')[-1] if url else '(native)'
        selfn[(fn,f)]+=d; byfile[f]+=d
    # only show isolates with meaningful busy time
    if busy/1000 < 30: continue
    print(f"\n########## ISOLATE {k} | busy {busy/1000:.0f}ms | idle {idle/1000:.0f}ms ##########")
    print("  top files:")
    for f,d in sorted(byfile.items(),key=lambda x:-x[1])[:10]:
        print(f"    {d/1000:7.1f}ms  {f[:72]}")
    print("  top functions:")
    for (fn,f),d in sorted(selfn.items(),key=lambda x:-x[1])[:16]:
        print(f"    {d/1000:7.1f}ms  {fn[:40]:40s} {f[:30]}")
