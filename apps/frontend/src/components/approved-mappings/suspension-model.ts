import type { ApprovedMappingStatus } from "@mediator/domain";

/**
 * The SL-10 suspend/resume affordance logic, kept pure so it is unit-testable without
 * mounting a component. It mirrors the **server's** transition rules — it never relaxes
 * them: the API is the authority and rejects an illegal transition with `409`; this only
 * keeps the affordances honest so the operator is not offered a button that must fail.
 *
 * `ApprovedMapping.status` is a **single** enum (`docs/architecture/data-model.md`), not two
 * coexisting markers, so exactly one action is available per status:
 *
 * - `active`    → **suspend** (the manual hold);
 * - `suspended` → **resume** (the exact inverse);
 * - `stale` / `superseded` / `archived` → **neither**. In particular a mapping that was
 *   suspended and then marked `stale` by a breaking spec change is `stale`: the
 *   more-blocking condition wins and it reaches `active` only through re-review, never
 *   through resume.
 */

/** The single action available on a mapping in a given status, or none with the reason. */
export type SuspensionAction =
  | { readonly kind: "suspend" }
  | { readonly kind: "resume" }
  | { readonly kind: "none"; readonly reason: string };

/** Which transition (if any) an operator may drive from `status`. */
export function suspensionAction(status: ApprovedMappingStatus): SuspensionAction {
  switch (status) {
    case "active":
      return { kind: "suspend" };
    case "suspended":
      return { kind: "resume" };
    case "stale":
      return {
        kind: "none",
        reason:
          "This mapping is stale — a breaking spec change invalidated it. It needs re-review (approve its successor proposal) to become active again; resuming does not apply.",
      };
    case "superseded":
      return {
        kind: "none",
        reason:
          "This mapping was superseded by an adopted successor. It is retained for audit and never executed again.",
      };
    case "archived":
      return {
        kind: "none",
        reason:
          "This mapping was archived when its app was deregistered. It is retained for audit and never executed again.",
      };
  }
}

/**
 * What a mapping in this status means for execution — the one line the operator needs to
 * know why a rule is not polling or a live call is failing.
 */
export function statusExplanation(status: ApprovedMappingStatus): string {
  switch (status) {
    case "active":
      return "Executing: its sync rules poll on their interval and its adapter bindings serve live calls.";
    case "suspended":
      return "On a manual operator hold: its sync rules are paused and its adapter bindings fail live calls with mapping-suspended. Nothing awaits re-review — resume lifts it.";
    case "stale":
      return "Paused by a breaking spec change: its sync rules are paused and its adapter bindings fail live calls with mapping-stale. It awaits re-review.";
    case "superseded":
      return "Replaced by an adopted successor mapping; never executed again.";
    case "archived":
      return "Archived with its deregistered app; never executed again.";
  }
}

/** PrimeVue `Tag` severity for a status — green only while the mapping actually executes. */
export function statusSeverity(status: ApprovedMappingStatus): "success" | "warn" | "secondary" {
  switch (status) {
    case "active":
      return "success";
    case "suspended":
    case "stale":
      return "warn";
    case "superseded":
    case "archived":
      return "secondary";
  }
}
