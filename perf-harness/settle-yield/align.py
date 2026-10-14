"""align.py : reads tab-separated rows on stdin and prints them as aligned
columns, for machines without `column`."""
import sys
rows=[l.rstrip('\n').split('\t') for l in sys.stdin]
w=[max(len(r[i]) for r in rows if i<len(r)) for i in range(max(map(len,rows)))]
for r in rows: print('  '.join(c.rjust(w[i]) if i else c.ljust(w[i]) for i,c in enumerate(r)))
