"""render-table.py <out-dir> <label>... : one row per `render.sh` label.

Seconds throughout. `yieldN` and `yieldT` are the count and total time of the
turns the settle loop handed back (`scheduler/execute/yield`); `silMax` and
`sil2` are the two longest stretches in which the client sent a frame and
read none.
"""
import json, re, sys, os
out = sys.argv[1]
def rows_of(path):
    d = json.load(open(path)); rows = {}
    def walk(o, p=''):
        if isinstance(o, dict):
            if 'count' in o and 'max' in o: rows[p] = o
            else:
                for k, v in o.items(): walk(v, p + '/' + k if p else k)
    walk(d); return rows
def g(rows, suf):
    for p, o in rows.items():
        if p.endswith(suf): return o
    return {'count': 0, 'max': 0, 'totalTime': 0}
hdr = ['label','wall','user','sys','settleMax','yieldN','yieldT','runs','runT','prepT','actT','sortT','silMax','sil2','in','out','wAdd','load']
print('\t'.join(hdr))
for label in sys.argv[2:]:
    try:
        err = open(f'{out}/{label}.err', errors='replace').read()
        m = re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys', err)
        wall, user, sysc = (float(x) for x in m.groups()) if m else (0, 0, 0)
        r = rows_of(f'{out}/{label}.timing.json')
        fr = [json.loads(l) for l in open(f'{out}/{label}.frames.jsonl') if l.strip()]
        fr = sorted([f for f in fr if f.get('dir') in ('in', 'out')], key=lambda f: f['t'])
        last = fr[0]['t']; sent = 0; sil = []
        for f in fr:
            if f['dir'] == 'out': sent += 1; continue
            if sent > 0: sil.append(f['t'] - last)
            last = f['t']; sent = 0
        sil.sort(reverse=True); sil += [0, 0]
        ins = sum(1 for f in fr if f['dir'] == 'in')
        wadd = sum(1 for f in fr if f['dir'] == 'out' and f.get('type') == 'session.watch.add')
        load = open(f'{out}/{label}.load').read().split('\n')[0].split()[0]
        s = lambda ms: f'{ms/1000:.1f}'
        y = g(r, 'execute/yield')
        print('\t'.join([label, f'{wall:.0f}', f'{user:.0f}', f'{sysc:.0f}', s(g(r,'execute/settle')['max']),
            str(y['count']), s(y['totalTime']), str(g(r,'scheduler/run')['count']), s(g(r,'scheduler/run')['totalTime']),
            s(g(r,'prepareCfc')['totalTime']), s(g(r,'run/action')['totalTime']), s(g(r,'topologicalSort')['totalTime']),
            s(sil[0]), s(sil[1]), str(ins), str(len(fr)-ins), str(wadd), load]))
    except Exception as e:
        print(label, 'ERR', repr(e))
