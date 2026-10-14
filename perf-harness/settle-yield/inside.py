"""inside.py <out-dir> <label>... : for the longest receive silence inside the
longest settle span, what the client's measures show in that window: the turns
it handed back, the action runs, the longest single measure, and the frames
outstanding (sent and not answered) when it began."""
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
    big = max((m for m in ms if name(m).endswith('scheduler/execute/settle')), key=lambda m: m['duration'])
    s0, s1 = big['startTime'], big['startTime'] + big['duration']
    last = fr[0]['t']; sent = []; best = None
    for f in fr:
        if f['dir'] == 'out': sent.append(f); continue
        a, b = last + off, f['t'] + off
        if sent and min(b, s1) > max(a, s0):
            ov = min(b, s1) - max(a, s0)
            if best is None or ov > best[0]: best = (ov, a, b, sent, f)
        last = f['t']; sent = []
    ov, a, b, snt, end = best
    win = [m for m in ms if m['startTime'] >= a and m['startTime'] + m['duration'] <= b]
    y = [m for m in win if name(m).endswith('execute/yield')]
    runs = [m for m in win if name(m).endswith('scheduler/run')]
    longest = sorted((m for m in ms if m['startTime'] < b and m['startTime'] + m['duration'] > a
                      and m['duration'] < big['duration'] - 1), key=lambda m: -m['duration'])[:4]
    # Requests sent before the silence still unanswered when it began.
    ids = {}
    for f in fr:
        if f['t'] + off > a: break
        rid = f.get('requestId')
        if rid is None: continue
        if f['dir'] == 'out': ids[rid] = f
        elif f.get('type') == 'response': ids.pop(rid, None)
    print(f"{label}: silence {b-a:.0f}ms at {a/1000:.1f}-{b/1000:.1f}; sent in it {[f.get('type') for f in snt]};"
          f" ended by {end.get('type')} {end.get('requestId','')[:8]}")
    print(f"   in window: {len(y)} turns ({sum(m['duration'] for m in y):.0f}ms), {len(runs)} runs ({sum(m['duration'] for m in runs):.0f}ms);"
          f" unanswered at start {len(ids)} {sorted({f.get('type') for f in ids.values()})}")
    print("   longest overlapping measures: " + "; ".join(f"{name(m)} {m['duration']:.0f}ms" for m in longest))
