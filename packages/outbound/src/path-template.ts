import type { IrOperation, ScopePathBinding } from "@mediator/domain";

/**
 * **Scope path-parameter substitution + the backstop** (SS-4) — the shared, transport-
 * agnostic path-template helpers the binding resolvers and the outbound readers/executor
 * both reason over.
 *
 * A scoped operation's path carries two kinds of path parameter (`docs/glossary.md`
 * *scope path-parameter binding*, `docs/architecture/data-model.md` `ResourceBinding.
 * scopePathBindings` / `OperationMapping.targetIdParamRef`):
 *
 *  - the **record-id** parameter — filled per record from the `RecordLink` downstream
 *    (the Outbound Call Executor / single-record reader), so the resolver must leave it
 *    **templated**; a scope constant is *never* substituted into it, and it is *never*
 *    filled from a scope; and
 *  - every other (**scope**) parameter — a container locator (`{owner}`/`{repo}`, a
 *    project `{id}`, a `{tenant}`) filled at resolution from the resource's confirmed
 *    `constant` scope bindings.
 *
 * {@link fillScopePathParameters} performs the substitution keyed to the operation's
 * **role** (the caller names which parameter, if any, is the record id) rather than to a
 * bare parameter name — so the Vikunja `{id}` collision resolves correctly (a scope
 * `{id}` on `PUT /projects/{id}/tasks` create is filled; a record-id `{id}` on
 * `POST /tasks/{id}` update stays templated). {@link findUnfilledPathParam} is the
 * defense-in-depth backstop the readers/executor apply just before sending: a
 * genuinely-unfilled scope `{…}` refuses the call rather than fabricating a URL.
 */

/**
 * Substitute the resource's confirmed `constant` scope bindings into a path template's
 * **scope** (non-record-id) path parameters, leaving the record-id parameter — named by
 * `recordIdPathParamName` when the operation has one **in its path** — templated for the
 * downstream per-record id-fill from the `RecordLink`.
 *
 * Returns the filled path, or `undefined` when a scope path parameter has **no confirmed**
 * `constant` binding — never a fabricated value (SS-4.4; the module invariant *never
 * fabricate a binding from an unconfirmed ref*, defense-in-depth behind the SS-5 gate). A
 * path with no scope parameters (only the record id, or none) passes through unchanged.
 *
 * The record-id parameter is matched **by name and only against the caller-supplied
 * `recordIdPathParamName`** — a scope parameter is never treated as the record id even
 * when it shares a bare name across a *different* operation (the caller keys the fill to
 * the operation's role, so `recordIdPathParamName` is that operation's own id parameter).
 */
export function fillScopePathParameters(
  pathTemplate: string,
  scopePathBindings: readonly ScopePathBinding[],
  recordIdPathParamName: string | undefined,
): string | undefined {
  let path = pathTemplate;
  for (const name of new Set(pathParameterNames(pathTemplate))) {
    if (name === recordIdPathParamName) {
      // The record-id parameter — filled later from the `RecordLink`, never from a scope.
      continue;
    }
    const value = confirmedConstantValue(scopePathBindings, name);
    if (value === undefined) {
      // SS-4.4 — an unconfirmed / absent scope constant never fabricates a URL.
      return undefined;
    }
    path = path.split(`{${name}}`).join(encodeURIComponent(value));
  }
  return path;
}

/**
 * The **scope** (non-record-id) path parameters of an operation — the read-side
 * complement of {@link fillScopePathParameters}: its distinct path-template parameter
 * names **minus** the record-id parameter (`recordIdParamName` when the operation has
 * one in its path), in first-appearance order.
 *
 * It is the shared classifier the SS-5 enablement gate (`docs/requirements/
 * scoped-resource-sync.md` SS-5) uses to compute the scope bindings a scoped rule
 * requires, deliberately routed through the **same** {@link pathParameterNames} +
 * record-id skip that {@link fillScopePathParameters} substitutes over — so the gate's
 * required set exactly matches what the resolver fills (never a param the resolver
 * cannot fill, never a `{…}` the resolver leaves for the backstop). The caller keys the
 * record-id determination to the operation's role exactly as SS-4 does (a write's
 * `OperationMapping.targetIdParamRef`-if-path, a single-record read's own id parameter,
 * `undefined` for a collection/poll read — every path param is then scope); an operation
 * whose only path parameter is the record id contributes none (SS-5.3).
 */
export function scopeParamNamesOf(
  operation: IrOperation,
  recordIdParamName: string | undefined,
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of pathParameterNames(operation.path)) {
    if (name === recordIdParamName || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The first still-templated `{param}` token in a path that should already be fully
 * resolved (a scope constant substituted, the record id about to be / already filled),
 * or `undefined` when none remains — the SS-4.5 backstop the outbound readers/executor
 * apply before sending, so a literal `{owner}` is never put on the wire and a 404 is
 * never fabricated into a not-found or a silent wrong-URL write. Callers invoke this
 * **after** the record-id substitution, so the still-templated record id never
 * false-trips it.
 */
export function findUnfilledPathParam(path: string): string | undefined {
  const match = /\{[^}]+\}/.exec(path);
  return match !== null ? match[0] : undefined;
}

/** Every `{name}` path-parameter token in a template, in order (duplicates included). */
function pathParameterNames(pathTemplate: string): string[] {
  const names: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null = regex.exec(pathTemplate);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
    match = regex.exec(pathTemplate);
  }
  return names;
}

/**
 * The value of the **confirmed** `constant` scope binding for `parameterName`, or
 * `undefined` when absent/unconfirmed/empty. A binding is confirmed iff both
 * `confirmedBy` and `confirmedAt` are set (mirrors the `ConfirmableRef` discipline); the
 * schema already forbids a confirmed constant from carrying an empty value, but the
 * emptiness guard here keeps the resolver from ever composing a `//` path from a
 * malformed row.
 *
 * The `binding.kind === "constant"` narrow both selects the `constant` member (so
 * `binding.value` type-checks — mirroring the domain `scopePathBindingSchema` superRefine)
 * and keeps this resolver **constant-only**: a `record-derived` (SS-8) / `scope-link`
 * entry yields no constant literal here, so the parameter is left `{…}` — filling a
 * `record-derived` scope parameter from the record's captured scope is SS-8b's resolver
 * fill, not this function.
 */
function confirmedConstantValue(
  scopePathBindings: readonly ScopePathBinding[],
  parameterName: string,
): string | undefined {
  for (const binding of scopePathBindings) {
    if (
      binding.kind === "constant" &&
      binding.parameterName === parameterName &&
      binding.confirmedBy !== null &&
      binding.confirmedAt !== null &&
      binding.value.length > 0
    ) {
      return binding.value;
    }
  }
  return undefined;
}
