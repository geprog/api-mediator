import { operationKey } from "@mediator/adapter-engine";
import type { Ir } from "@mediator/domain";

/**
 * The REST realization of the Protocol Server seam's route table (RT-2). This
 * module is where OpenAPI/REST specifics live — HTTP verbs and path templating —
 * behind the seam, so the `@mediator/adapter-engine` core never sees them (RT-1.5).
 *
 * Routes are **derived from the consumer spec's IR**, never hand-written (RT-2.1):
 * one route per IR operation, its {@link operationKey} computed by the core so a
 * matched route and its `AdapterEndpoint` agree on the same key.
 */

/** One compiled segment of a path template: a literal, or a `{name}` capture. */
type RouteSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string };

/** One routable REST operation of a mounted consumer surface. */
export interface RestRoute {
  /** Upper-case HTTP method (`GET`, `POST`, …), matching `FastifyRequest.method`. */
  readonly method: string;
  /** The OpenAPI path template, e.g. `/lists/{listId}/todos`. */
  readonly pathTemplate: string;
  /** The neutral operation key (`resourceRef/operationId`) the endpoint is keyed by. */
  readonly operationKey: string;
  /** The compiled template segments, used by {@link matchRoute}. */
  readonly segments: readonly RouteSegment[];
}

/** A successful route match: the route plus the captured path-template parameters. */
export interface RouteMatch {
  readonly route: RestRoute;
  readonly pathParameters: Readonly<Record<string, string>>;
}

/**
 * Split a path into its non-empty segments, tolerating a leading slash (every
 * OpenAPI path has one) and a single trailing slash (`/todos/` ≡ `/todos`). The
 * root path `/` yields `[]`.
 */
function splitPath(path: string): string[] {
  const segments = path.split("/");
  // Drop the leading empty segment produced by the leading `/`.
  if (segments[0] === "") {
    segments.shift();
  }
  // Drop a single trailing empty segment produced by a trailing `/`.
  if (segments.length > 0 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  return segments;
}

/** Compile a path template into {@link RouteSegment}s (`{name}` → a `param`). */
function compileTemplate(pathTemplate: string): RouteSegment[] {
  return splitPath(pathTemplate).map((segment) => {
    if (segment.startsWith("{") && segment.endsWith("}") && segment.length > 2) {
      return { kind: "param", name: segment.slice(1, -1) };
    }
    return { kind: "static", value: segment };
  });
}

/** The number of static (literal) segments in a route — its specificity score. */
function staticSegmentCount(route: RestRoute): number {
  return route.segments.filter((segment) => segment.kind === "static").length;
}

/**
 * Derive every routable operation of a consumer spec from its {@link Ir} (RT-2.1).
 * The method is upper-cased for matching; the key comes from the core so there is
 * exactly one definition of an operation's identity across the runtime.
 */
export function deriveRestRoutes(ir: Ir): RestRoute[] {
  const routes: RestRoute[] = [];
  for (const group of ir) {
    for (const operation of group.operations) {
      routes.push({
        method: operation.method.toUpperCase(),
        pathTemplate: operation.path,
        operationKey: operationKey(group.resourceRef, operation.operationId),
        segments: compileTemplate(operation.path),
      });
    }
  }
  return routes;
}

/** Try to match a concrete `path` against one route's template, capturing params. */
function matchOne(route: RestRoute, pathSegments: readonly string[]): RouteMatch | undefined {
  if (route.segments.length !== pathSegments.length) {
    return undefined;
  }
  const pathParameters: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index];
    const value = pathSegments[index];
    if (segment === undefined || value === undefined) {
      return undefined;
    }
    if (segment.kind === "static") {
      if (segment.value !== value) {
        return undefined;
      }
    } else {
      // A path-template parameter never matches an empty segment.
      if (value.length === 0) {
        return undefined;
      }
      pathParameters[segment.name] = decodeURIComponent(value);
    }
  }
  return { route, pathParameters };
}

/**
 * Match an inbound `(method, path)` against a consumer app's routes (RT-2.2). No
 * match → `undefined`, which the Request Router turns into a plain **404**
 * (deliberately distinguishable from `not-yet-mapped`).
 *
 * When several templates match the same request, the **most static-specific** one
 * wins (a literal beats a `{param}` at the same position — `/todos/count` beats
 * `/todos/{id}`), with the lexicographically-smallest template as a deterministic
 * final tiebreak so matching is stable across requests.
 */
export function matchRoute(
  routes: readonly RestRoute[],
  method: string,
  path: string,
): RouteMatch | undefined {
  const pathSegments = splitPath(path);
  const upperMethod = method.toUpperCase();
  const matches: RouteMatch[] = [];
  for (const route of routes) {
    if (route.method !== upperMethod) {
      continue;
    }
    const match = matchOne(route, pathSegments);
    if (match !== undefined) {
      matches.push(match);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((left, right) => {
    const specificity = staticSegmentCount(right.route) - staticSegmentCount(left.route);
    if (specificity !== 0) {
      return specificity;
    }
    return left.route.pathTemplate.localeCompare(right.route.pathTemplate);
  });
  return matches[0];
}
