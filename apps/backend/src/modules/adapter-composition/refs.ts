/**
 * The single qualified→bare boundary for **operation-input parameter refs** inside
 * the CO-2 composition slice.
 *
 * A backend operation's parameter is addressed in the mapping/composition vocabulary
 * as a `resourceRef/operationId#name` ref (`OperationMapping.sourceOperationRef` +
 * `#name`), while an {@link import("@mediator/domain").IrParameter} carries only the
 * bare `name`. {@link bareParamName} reduces a ref to that bare name so a
 * `ParameterMapping.targetParamRef` or an `AdapterBinding.chainInputs[].targetParamRef`
 * can be matched against the backend operation's declared parameters — CO-2.5's
 * "`targetParamRef` must be a real parameter of this binding's backend operation" and
 * CO-2.6's required-parameter coverage.
 *
 * It mirrors the Adapter Server Runtime's own `paramRefBareName`
 * (`http/adapter-runtime/serve/request-mapping.ts`) deliberately: a parameter the
 * runtime fills **by bare name** is exactly the parameter composition must be able to
 * name, so the two must agree on what "the same parameter" means. Kept as its own tiny
 * definition here (the same way `serve-context.ts` keeps its own `parseOperationRef`)
 * rather than reaching across into the request-serving module.
 */
export function bareParamName(ref: string): string {
  const hash = ref.lastIndexOf("#");
  if (hash !== -1 && hash < ref.length - 1) {
    return ref.slice(hash + 1);
  }
  const slash = ref.lastIndexOf("/");
  return slash !== -1 && slash < ref.length - 1 ? ref.slice(slash + 1) : ref;
}
