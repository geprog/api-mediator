#!/usr/bin/env python3
"""Prune unreferenced reusable components from a Swagger 2.0 / OpenAPI 3 spec.

usage: prune-swagger-refs.py <in.json> <out.json>

After trim-specs.sh has dropped paths, this removes everything the surviving
paths no longer reference: computes the transitive closure of local ``$ref``
pointers reachable from ``paths`` and filters the reusable containers
(Swagger 2.0: definitions/parameters/responses; OAS3: components/*) down to
that closure. Security schemes are kept wholesale (they are referenced by name,
not by $ref). Top-level ``tags`` are pruned to tags still used by operations.
Only stdlib — no dependencies.
"""

import json
import sys

SWAGGER2_CONTAINERS = [("definitions",), ("parameters",), ("responses",)]
OAS3_COMPONENTS = [
    "schemas", "parameters", "responses", "requestBodies", "headers",
    "examples", "links", "callbacks",
]


def collect_refs(node, acc):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str) and value.startswith("#/"):
                acc.add(value)
            else:
                collect_refs(value, acc)
    elif isinstance(node, list):
        for item in node:
            collect_refs(item, acc)


def resolve(spec, ref):
    node = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1]) as fh:
        spec = json.load(fh)

    closure = set()
    collect_refs(spec.get("paths", {}), closure)
    # webhooks (OAS 3.1) count as roots too, if present
    collect_refs(spec.get("webhooks", {}), closure)

    frontier = set(closure)
    while frontier:
        next_frontier = set()
        for ref in frontier:
            target = resolve(spec, ref)
            if target is None:
                print(f"warning: unresolvable {ref}", file=sys.stderr)
                continue
            found = set()
            collect_refs(target, found)
            next_frontier |= found - closure
        closure |= next_frontier
        frontier = next_frontier

    containers = list(SWAGGER2_CONTAINERS)
    if "components" in spec:
        containers += [("components", name) for name in OAS3_COMPONENTS]

    removed = 0
    for path in containers:
        parent = spec
        for part in path[:-1]:
            parent = parent.get(part, {})
        container = parent.get(path[-1])
        if not isinstance(container, dict):
            continue
        prefix = "#/" + "/".join(path)
        kept = {
            key: value
            for key, value in container.items()
            if f"{prefix}/{key.replace('~', '~0').replace('/', '~1')}" in closure
        }
        removed += len(container) - len(kept)
        parent[path[-1]] = kept

    if isinstance(spec.get("tags"), list):
        used_tags = set()
        for path_item in spec.get("paths", {}).values():
            if not isinstance(path_item, dict):
                continue
            for op in path_item.values():
                if isinstance(op, dict):
                    used_tags.update(op.get("tags", []))
        spec["tags"] = [t for t in spec["tags"] if t.get("name") in used_tags]

    with open(sys.argv[2], "w") as fh:
        json.dump(spec, fh, indent=2, sort_keys=True)
        fh.write("\n")
    ops = sum(
        1
        for item in spec.get("paths", {}).values()
        if isinstance(item, dict)
        for method in item
        if method in ("get", "post", "put", "patch", "delete", "head", "options")
    )
    print(
        f"pruned {removed} unreferenced components; "
        f"{len(spec.get('paths', {}))} paths / {ops} operations remain",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
