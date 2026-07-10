/**
 * `exactOptionalPropertyTypes` distinguishes an **absent** optional key from one
 * that is present with the value `undefined`. Zod's `.optional()` infers
 * `T | undefined`, so the *type* alone does not preserve that distinction — a
 * present `key: undefined` is a valid value of an `.optional()` field, and Zod v4
 * carries such a present-`undefined` key through `parse`. The distinction that
 * *is* guaranteed is runtime-only and narrower: parsing input that **omits** an
 * optional key yields an object that also omits it.
 *
 * Persistence boundaries cannot rely on the type guarantee: a nullable database
 * column read back as `null` naturally becomes a present `key: undefined` unless
 * something removes it. {@link stripUndefined} is that something — the
 * `@mediator/db` row→domain mappers run their assembled object through it so a
 * NULL column / absent child row becomes a truly **absent** key rather than
 * `key: undefined`, keeping "absent" distinct under `exactOptionalPropertyTypes`.
 */

/** Collapse an intersection of object types into a single object type. */
type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * `T` with every key whose value type includes `undefined` turned into a *truly
 * optional* key (and `undefined` removed from its value type). The result is
 * assignable to a target with `exactOptionalPropertyTypes` because such keys are
 * modeled as absent-or-present-with-a-defined-value, never present-`undefined`.
 */
export type WithoutUndefined<T> = Flatten<
  {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
  } & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
  }
>;

/**
 * Return a shallow copy of `value` with every entry whose value is `undefined`
 * omitted, so the result has *absent* keys rather than present-`undefined` ones.
 *
 * The single type assertion is unavoidable: the result is built by iterating
 * entries, which the compiler cannot connect to the mapped {@link WithoutUndefined}
 * shape. It is sound — the loop copies exactly the defined entries of `value`,
 * which is precisely what `WithoutUndefined<T>` describes.
 */
export function stripUndefined<T extends Record<string, unknown>>(value: T): WithoutUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result as WithoutUndefined<T>;
}
