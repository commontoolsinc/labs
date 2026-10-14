"""silences.py <out-dir> <label>... : the three longest receive silences per
render, on the measure clock (aligned as settle-silence.py aligns them), with
the frames sent in them and the spans they overlap."""
import json, sys
out = sys.argv[1]
name = lambda m: m['name'].split('#')[0].removeprefix('cf:')
for label in sys.argv[2:]:
    ms = json.load(open(f'{out}/{label}.measures.json'))
    reqs = sorted((m for m in ms if name(m).endswith('watchAdd/request')), key=lambda m: m['startTime'])
    fr = [json.loads(l) for l in open(f'{out}/{label}.frames.jsonl') if l.strip()]
    fr = sorted([f for f in fr if f.get('dir') in ('in', 'out')], key=lambda f: f['t'])
    first_add = next(f for f in fr if f['dir'] == 'out' and f.get('type') == 'session.watch.add')
    off = reqs[0]['startTime'] - first_add['t']
    settles = [m for m in ms if name(m).endswith('scheduler/execute/settle')]
    big = max(settles, key=lambda m: m['duration'])
    spans = [m for m in ms if name(m).startswith('start/') and m['duration'] > 200]
    last = fr[0]['t']; sent = []; sil = []
    for f in fr:
        if f['dir'] == 'out': sent.append(f); continue
        if sent: sil.append((f['t'] - last, last, f['t'], sent, f))
        last = f['t']; sent = []
    sil.sort(key=lambda s: -s[0])
    print(f"{label}: settle {big['startTime']/1000:.1f}-{(big['startTime']+big['duration'])/1000:.1f}")
    for d, a, b, snt, end in sil[:3]:
        a2, b2 = a + off, b + off
        types = {}
        for f in snt: types[f.get('type')] = types.get(f.get('type'), 0) + 1
        over = sorted({name(m) for m in spans if m['startTime'] < b2 and m['startTime'] + m['duration'] > a2})
        ins = big['startTime'] < b2 and big['startTime'] + big['duration'] > a2
        print(f"  {d/1000:5.1f}s at {a2/1000:5.1f}-{b2/1000:5.1f} sent {types} ended by {end.get('type')}"
              f" {'IN SETTLE ' if ins else ''}spans {over}")
