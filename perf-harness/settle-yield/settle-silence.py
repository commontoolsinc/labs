"""settle-silence.py <out-dir> <label>... : the longest receive silence that
overlaps the longest settle span, with the two clocks aligned on the first
watch request (its measure's start and its frame's time)."""
import json, sys
out = sys.argv[1]
for label in sys.argv[2:]:
    ms = json.load(open(f'{out}/{label}.measures.json'))
    # A measure is named `cf:<keys>#<serial>`.
    name = lambda m: m['name'].split('#')[0]
    settles = [m for m in ms if name(m).endswith('scheduler/execute/settle')]
    reqs = sorted((m for m in ms if name(m).endswith('watchAdd/request')), key=lambda m: m['startTime'])
    fr = [json.loads(l) for l in open(f'{out}/{label}.frames.jsonl') if l.strip()]
    fr = sorted([f for f in fr if f.get('dir') in ('in', 'out')], key=lambda f: f['t'])
    first_add = next(f for f in fr if f['dir'] == 'out' and f.get('type') == 'session.watch.add')
    off = reqs[0]['startTime'] - first_add['t']          # measure clock = frame clock + off
    big = max(settles, key=lambda m: m['duration'])
    s0, s1 = big['startTime'] - off, big['startTime'] + big['duration'] - off
    last = fr[0]['t']; sent = 0; sil = []
    for f in fr:
        if f['dir'] == 'out': sent += 1; continue
        if sent > 0: sil.append((last, f['t'], sent))
        last = f['t']; sent = 0
    inside = [(min(b, s1) - max(a, s0), a, b, n) for a, b, n in sil if min(b, s1) > max(a, s0)]
    inside.sort(reverse=True)
    ins = sum(1 for f in fr if f['dir'] == 'in' and s0 <= f['t'] <= s1)
    outs = sum(1 for f in fr if f['dir'] == 'out' and s0 <= f['t'] <= s1)
    top = inside[0] if inside else (0, 0, 0, 0)
    print(f"{label}: settle {big['duration']/1000:.1f}s at {s0/1000:.1f}-{s1/1000:.1f}; longest silence overlapping it {top[0]/1000:.1f}s "
          f"(whole silence {(top[2]-top[1])/1000:.1f}s, {top[3]} sent); frames read during settle {ins}, sent {outs}; n settles {len(settles)}, offset {off:.0f}ms")
