# 08 — Consistency checks for `docs/plan.md`

Run these after editing the plan.

```sh
npm install                                   # mermaid 11 + playwright
python3 check_plan.py ../../../plan.md        # anchors + [R#] refs; writes blocks.json
node render_mermaid.cjs                       # renders every mermaid block in headless Chromium
python3 extract_ids.py ../../../plan.md       # detailed R#/X-id/lab-page cross-reference report
```

- `check_plan.py` exits non-zero on a broken `#anchor` (GitHub slug rules) or an undefined `[R#]`.
- `render_mermaid.cjs` prints `OK` or the parser error for each diagram.
