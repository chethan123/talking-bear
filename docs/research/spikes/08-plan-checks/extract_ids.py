import re, collections, sys
p=sys.argv[1] if len(sys.argv)>1 else 'docs/plan.md'
lines=open(p,encoding='utf-8').read().split('\n')
text='\n'.join(lines)

# ---- R# definitions (rows in §13 tables: "| R12 | ...")
defs={}
for i,l in enumerate(lines,1):
    m=re.match(r'^\|\s*(R\d+)\s*\|',l)
    if m: defs[m.group(1)]=i
# ---- R# uses anywhere (incl ranges like R45–R48, R1–R3)
uses=collections.defaultdict(list)
for i,l in enumerate(lines,1):
    if i in defs.values() and re.match(r'^\|\s*R\d+\s*\|',l): continue
    for m in re.finditer(r'\bR(\d+)(?:\s*[–-]\s*R?(\d+))?\b',l):
        a=int(m.group(1)); b=int(m.group(2)) if m.group(2) else a
        # guard: only treat as range if b>a and small span
        if m.group(2) and (b<a or b-a>10): b=a
        for k in range(a,b+1): uses['R%d'%k].append(i)
print("== R# defined but never used:")
for r in sorted(defs,key=lambda x:int(x[1:])):
    if r not in uses: print("  ",r,"(def line",defs[r],")")
print("== R# used but never defined:")
for r in sorted(uses,key=lambda x:int(x[1:])):
    if r not in defs: print("  ",r,"lines",uses[r])
print("== defined IDs:",sorted(defs,key=lambda x:int(x[1:])))
allnums=sorted(int(x[1:]) for x in defs)
print("== gaps in definition numbering:",[n for n in range(1,max(allnums)+1) if n not in allnums])

# ---- X-IDs
xdef={}
for i,l in enumerate(lines,1):
    m=re.match(r'^\|\s*(X-[A-Z]+\d+)\s*\|',l)
    if m: xdef[m.group(1)]=i
xuse=collections.defaultdict(list)
for i,l in enumerate(lines,1):
    if re.match(r'^\|\s*X-[A-Z]+\d+\s*\|',l): continue
    for m in re.finditer(r'\bX-[A-Z]+\d+\b',l): xuse[m.group(0)].append(i)
print("\n== X-IDs defined in §5:",sorted(xdef))
print("== X-IDs referenced but not defined:",{k:v for k,v in xuse.items() if k not in xdef})
print("== X-IDs defined but never referenced elsewhere:",[k for k in xdef if k not in xuse])
print("== X-ID refs by line:")
for k in sorted(xuse): print("  ",k,xuse[k])

# ---- lab pages
lab=collections.defaultdict(list)
for i,l in enumerate(lines,1):
    for m in re.finditer(r'`?/?lab/([a-z-]+)(?:\.html)?`?',l): lab[m.group(1)].append(i)
print("\n== lab pages referenced:")
for k in sorted(lab): print("  ",k,lab[k])

# ---- Q refs
q=collections.defaultdict(list)
for i,l in enumerate(lines,1):
    for m in re.finditer(r'\bQ([1-9])\b',l): q['Q'+m.group(1)].append(i)
print("\n== Q refs:",{k:v for k,v in sorted(q.items())})

# ---- numbers of interest
for pat in [r'hangover',r'pre-roll|preRoll|pre roll',r'cooldown',r'45 s|120 s|2 min|T_sleep|T_doze|doz',r'10 s|maxUtterance|max utterance',r'12 s|ring',r'DPR|devicePixelRatio',r'fps',r'wasm-unsafe-eval',r'precache|2 MiB|16 MiB|1 MB|1\.5 MB',r'0\.35|0\.5 /|posThreshold|negative',r'\bD2\b|\bD3\b|D1–D3',r"\+18 dB|-1 dBFS|−1 dBFS|loud",r'Talking Tom|Outfit7|Talking Bear']:
    print("\n== pattern:",pat)
    for i,l in enumerate(lines,1):
        if re.search(pat,l): print("  %4d: %s"%(i,l.strip()[:160]))
