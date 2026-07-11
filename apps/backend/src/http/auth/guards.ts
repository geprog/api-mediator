import type { OperatorRole } from "@mediator/config";
import type { preHandlerHookHandler } from "fastify";

import { ForbiddenError } from "../../app-errors.js";
import { getPrincipal } from "./principal.js";

/**
 * Role gating (OA-2). The two roles are ranked so `operator` satisfies any
 * requirement and `viewer` satisfies only a viewer requirement — the read/mutate
 * split, with no finer hierarchy (single-tenant).
 */
const ROLE_RANK: Record<OperatorRole, number> = { viewer: 1, operator: 2 };

/**
 * Build a `preHandler` that requires at least `minimum` role. Authentication is
 * already guaranteed by the OA-1 hook, so this only checks authorization: a
 * principal below the required rank is rejected 403 ({@link ForbiddenError})
 * before the handler runs, so nothing is mutated (OA-2 crit 2).
 */
export function requireRole(minimum: OperatorRole): preHandlerHookHandler {
  return function guard(request, _reply, done): void {
    const principal = getPrincipal(request);
    if (ROLE_RANK[principal.role] < ROLE_RANK[minimum]) {
      done(new ForbiddenError(`This action requires the ${minimum} role.`));
      return;
    }
    done();
  };
}

/**
 * Guard for mutating routes — register/disable an app, store credentials, confirm
 * a `ResourceBinding`, set `analysisExclusions`, and (in the approval slice)
 * accept/edit/reject items, confirm identity keys, approve, and the escape-hatch
 * analysis (OA-2 crit 2/3/5/6).
 */
export const requireOperator: preHandlerHookHandler = requireRole("operator");

/**
 * Guard for read routes — any authenticated principal (operator or viewer) may
 * read (OA-2 crit 1). Applied explicitly so every route declares its minimum
 * role and the read/mutate boundary is visible at each handler.
 */
export const requireViewer: preHandlerHookHandler = requireRole("viewer");
