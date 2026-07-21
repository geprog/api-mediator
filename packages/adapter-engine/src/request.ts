/**
 * The **protocol-neutral inbound request** the Adapter Server Runtime's serving
 * core consumes (RT-1.5, the server side of the Protocol Client/Server seam). The
 * REST Protocol Server translates an HTTP request into this shape; a future
 * non-REST protocol would produce the same shape from its own wire form, so the
 * planner/executor/aggregator behind the seam never sees HTTP.
 *
 * RT-2.4: path-template parameters, query, headers, and body are all captured —
 * the mount does not narrow the surface to a subset of parameter locations.
 *
 * Security note (RT-5.5): `headers` may carry the caller's adapter token (an
 * `Authorization` header). That is consumed by the Auth Gateway (AT, the next
 * slice) and used by the Transformation Executor (TE) for parameter mapping; it is
 * **never** written to the Audit Log or telemetry, which record ids/enums only.
 */
export interface AdapterRequest {
  /** The consumer app the caller is identified as (the AT token→app seam, RT-2.3). */
  readonly consumerAppId: string;
  /** The mounted operation this request resolved to (`resourceRef/operationId`). */
  readonly operationKey: string;
  /** Path-template parameters captured from the matched route (e.g. `{listId}`). */
  readonly pathParameters: Readonly<Record<string, string>>;
  /** Query-string parameters; repeated keys keep all their values. */
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /** Request headers as received; repeated keys keep all their values. */
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** The parsed request body, or `undefined` when there is none. */
  readonly body: unknown;
}
