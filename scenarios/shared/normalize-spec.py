#!/usr/bin/env python3
"""Repair known upstream sins in generated OpenAPI/Swagger specs.

Reads a JSON spec on stdin, writes the repaired spec to stdout. Fixes applied
(all observed in real vendor specs — Wekan v9.57, Dolibarr 23):
  - operation `parameters` emitted as object instead of array (Wekan)
  - non-body params typed `object` — illegal in Swagger 2.0 (Wekan formData)
  - path parameters with required=false (Dolibarr/restler)
  - duplicate operationIds (Wekan exportJson, Dolibarr createSocieteAccount)
Only stdlib — no dependencies.
"""

import json
import sys

spec = json.load(sys.stdin)
seen_ids = set()
for item in spec.get("paths", {}).values():
    for op in (item or {}).values():
        if not isinstance(op, dict):
            continue
        if isinstance(op.get("parameters"), dict):
            op["parameters"] = list(op["parameters"].values())
        for p in op.get("parameters") or []:
            if not isinstance(p, dict):
                continue
            if p.get("in") != "body" and p.get("type") == "object":
                p["type"] = "string"
            if p.get("in") == "path":
                p["required"] = True
        op_id = op.get("operationId")
        if op_id:
            n, unique = 1, op_id
            while unique in seen_ids:
                n += 1
                unique = f"{op_id}_{n}"
            op["operationId"] = unique
            seen_ids.add(unique)

json.dump(spec, sys.stdout)
