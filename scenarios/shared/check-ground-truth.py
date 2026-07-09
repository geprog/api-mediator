#!/usr/bin/env python3
"""Check a scenario's ground-truth.yaml against its vendored specs.

usage: check-ground-truth.py <scenario-dir>

Collects every operation reference ("METHOD /path" string) from the ground
truth and verifies the path+method exists in at least one vendored full spec
(specs/full/*.json) or hand-written consumer spec (specs/consumer/*.yaml) —
so ground truth cannot silently drift when an image/spec is bumped.
Deliberately operations-only: field references use IR semantics a static
checker can't resolve. Requires PyYAML.
"""

import glob
import json
import re
import sys

import yaml

OP_RE = re.compile(r"^(GET|POST|PUT|PATCH|DELETE) (/\S*)$")


def collect_ops(node, acc):
    if isinstance(node, dict):
        for value in node.values():
            collect_ops(value, acc)
    elif isinstance(node, list):
        for item in node:
            collect_ops(item, acc)
    elif isinstance(node, str):
        m = OP_RE.match(node.strip())
        if m:
            acc.add((m.group(1).lower(), m.group(2)))


def main():
    scenario = sys.argv[1].rstrip("/")
    truth = yaml.safe_load(open(f"{scenario}/ground-truth.yaml"))

    known = set()
    spec_files = sorted(glob.glob(f"{scenario}/specs/full/*.json")) + sorted(
        glob.glob(f"{scenario}/specs/consumer/*.yaml")
    )
    if not spec_files:
        sys.exit(f"no specs found under {scenario}/specs")
    for f in spec_files:
        spec = yaml.safe_load(open(f)) if f.endswith(".yaml") else json.load(open(f))
        for path, item in (spec.get("paths") or {}).items():
            for method in item or {}:
                known.add((method, path))

    ops = set()
    collect_ops(truth, ops)
    missing = sorted(op for op in ops if op not in known)

    print(f"{scenario}: {len(ops)} operation references, {len(missing)} unresolved")
    for method, path in missing:
        print(f"  MISSING {method.upper()} {path}")
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
