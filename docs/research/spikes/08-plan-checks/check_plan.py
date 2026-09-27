#!/usr/bin/env python3
"""Check docs/plan.md: internal #anchors resolve (GitHub slug rules), [R#] refs are defined,
and extract ```mermaid blocks to blocks.json for render_mermaid.cjs."""
import json, re, sys
p = sys.argv[1] if len(sys.argv) > 1 else 'docs/plan.md'
s = open(p, encoding='utf-8').read()
json.dump(re.findall(r"```mermaid\n(.*?)```", s, re.S), open('blocks.json', 'w'))
body = re.sub(r"```.*?```", "", s, flags=re.S)
slug = lambda t: re.sub(r"[^\w\- ]", "", re.sub(r"`", "", t.strip()).lower()).replace(" ", "-")
slugs = {slug(m.group(2)) for m in re.finditer(r"^(#{1,6})\s+(.*)$", body, re.M)}
missing = sorted(l for l in set(re.findall(r"\]\(#([^)]+)\)", body)) if l not in slugs)
used = set(re.findall(r"\bR(\d+)\b", body)); defined = set(re.findall(r"^\| R(\d+) \|", s, re.M))
print("missing anchors:", missing)
print("refs used but undefined:", sorted(used - defined, key=int))
print("mermaid blocks written to blocks.json")
sys.exit(1 if missing or (used - defined) else 0)
