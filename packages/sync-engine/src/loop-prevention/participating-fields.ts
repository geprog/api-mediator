import type { FieldMapping, SyncFieldStateSide } from "@mediator/domain";

import type { MappingDirection } from "./types.js";

/**
 * Every field path on `side` (A|B, as the `RecordLink` defines them) that
 * participates in **any** of the given directions' mappings — the exact set EP-1's
 * echo compare must cover (`docs/architecture/sync-engine.md` *Loop prevention*;
 * EP-1.2 / `SyncFieldState` SD-3 criterion 5).
 *
 * For each direction, `side` participates as either:
 *  - an **input** — the transform's primary input (`sourcePath`) plus any additional
 *    `aggregate`/`expression` inputs (`transformConfig.additionalInputPaths`) — when
 *    `side` is that direction's **source**; or
 *  - an **output** — `targetPath` — when `side` is that direction's **target**.
 *
 * Taking the **union** across both directions is what keeps the check well-defined
 * when the two directions pair fields asymmetrically (A→B maps `a.x → b.y` while
 * B→A maps `b.y → a.z`) or a transform takes several inputs. The result is
 * deduplicated in first-seen order and mirrors exactly the per-side rows the seeder
 * writes, so every path here has (or should have) a `SyncFieldState` row.
 */
export function participatingFieldsForSide(
  side: SyncFieldStateSide,
  directions: readonly MappingDirection[],
): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  };

  for (const direction of directions) {
    const sideIsSource = direction.sourceSide === side;
    for (const field of direction.fieldMappings) {
      if (sideIsSource) {
        // `side` is this direction's source: its input fields live here.
        for (const input of inputPaths(field)) {
          add(input);
        }
      } else {
        // `side` is this direction's target: its output field lives here.
        add(field.targetPath);
      }
    }
  }

  return paths;
}

/** A field's input paths: the primary `sourcePath` plus any additional inputs. */
function inputPaths(field: FieldMapping): readonly string[] {
  return [field.sourcePath, ...(field.transformConfig?.additionalInputPaths ?? [])];
}
