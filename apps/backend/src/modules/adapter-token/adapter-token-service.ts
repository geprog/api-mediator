import { randomUUID } from "node:crypto";

import {
  AdapterTokenStore,
  DbAdapterTokenPersistence,
  type CutoverResult,
  type IssueTokenResult,
  type ValidateTokenResult,
} from "@mediator/credentials";
import { AuditLogRepository, tx, type Database, type DbHandle } from "@mediator/db";
import type { AuditLogEntry } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import { getActiveTraceContext } from "@mediator/telemetry";

import { DbConsumerAppEligibilityReader } from "./consumer-app-eligibility.js";

/**
 * Construction inputs for {@link AdapterTokenService}.
 *
 * `rotationOverlapMs` is the config-defined overlap window (AT-4.2). `now`/`newId`
 * are injectable seams so a test can pin the clock and the audit-row ids.
 */
export interface AdapterTokenServiceDeps {
  readonly db: Database;
  readonly rotationOverlapMs: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * The operator-facing token mutations the routes depend on. An interface (not the
 * concrete class) so the routes are unit-testable with a fake — {@link AdapterTokenService}
 * has private fields and so is not structurally fakeable.
 */
export interface AdapterTokenIssuer {
  issue(appId: string, actor: string): Promise<IssueTokenResult>;
  rotate(appId: string, actor: string): Promise<IssueTokenResult>;
  cutover(appId: string, actor: string): Promise<CutoverResult>;
}

/**
 * The operator-facing adapter-token service (AT-1/AT-4). It wraps the
 * `@mediator/credentials` {@link AdapterTokenStore} in a transaction so a successful
 * issue/rotate/cutover commits its state change **and** its operator-attributed
 * audit row atomically (OA-3). The audit row is metadata only — the operator
 * identity, the app, the credential id, and a short note — **never** the raw token
 * value (AT-1.3).
 *
 * A single audit `type = "credential-access"` row records the lifecycle action
 * (the credential-lifecycle audit vocabulary the data model already carries), with
 * the operator as `actor`; no new audit type is introduced (no migration).
 *
 * Validation (the per-request hot path) is read-only and does not open a
 * transaction; the gateway resolver uses {@link buildAdapterTokenValidator}.
 */
export class AdapterTokenService implements AdapterTokenIssuer {
  readonly #db: Database;
  readonly #rotationOverlapMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(deps: AdapterTokenServiceDeps) {
    this.#db = deps.db;
    this.#rotationOverlapMs = deps.rotationOverlapMs;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#newId = deps.newId ?? ((): string => randomUUID());
  }

  /** Issue a consumer app's adapter token, attributing the operator (AT-1). */
  public issue(appId: string, actor: string): Promise<IssueTokenResult> {
    return tx(this.#db, async (txn) => {
      const result = await this.#storeFor(txn).issue(appId);
      if (result.outcome === "issued") {
        await this.#recordAudit(txn, {
          actor,
          appId,
          credentialId: result.token.credentialId,
          details: result.rotated
            ? "adapter token re-issued (previous kept valid during overlap window)"
            : "adapter token issued",
        });
      }
      return result;
    });
  }

  /** Rotate a consumer app's token with an overlap window, attributing the operator (AT-4.1). */
  public rotate(appId: string, actor: string): Promise<IssueTokenResult> {
    return tx(this.#db, async (txn) => {
      const result = await this.#storeFor(txn).rotate(appId);
      if (result.outcome === "issued") {
        await this.#recordAudit(txn, {
          actor,
          appId,
          credentialId: result.token.credentialId,
          details: "adapter token rotated (previous kept valid during overlap window)",
        });
      }
      return result;
    });
  }

  /** End a rotation overlap early (explicit operator cutover), attributed (AT-4.2). */
  public cutover(appId: string, actor: string): Promise<CutoverResult> {
    return tx(this.#db, async (txn) => {
      const result = await this.#storeFor(txn).cutover(appId);
      if (result.outcome === "cutover") {
        await this.#recordAudit(txn, {
          actor,
          appId,
          // One ended credential is the common case; record it, else note the count.
          ...(result.endedCredentialIds.length === 1
            ? { credentialId: result.endedCredentialIds[0] }
            : {}),
          details: `adapter token cutover (ended ${String(result.endedCredentialIds.length)} previous token(s))`,
        });
      }
      return result;
    });
  }

  /**
   * The deregister-cascade step (AT-4.5): delete every adapter-token credential for
   * an app outright — deleted, **not** archived — so a live token dies with its app.
   * Returns the number of credential rows removed. The wider deregister cascade
   * (spec archival + surface teardown) owns its own transaction; this is the
   * credential-store contribution a cascade calls.
   */
  public deleteForApp(appId: string): Promise<number> {
    return tx(this.#db, (txn) => this.#storeFor(txn).deleteForApp(appId));
  }

  #storeFor(handle: DbHandle): AdapterTokenStore {
    return new AdapterTokenStore(
      new DbAdapterTokenPersistence(handle),
      new DbConsumerAppEligibilityReader(handle),
      { rotationOverlapMs: this.#rotationOverlapMs, now: this.#now },
    );
  }

  #recordAudit(
    handle: DbHandle,
    fields: {
      readonly actor: string;
      readonly appId: string;
      readonly credentialId?: string;
      readonly details: string;
    },
  ): Promise<void> {
    const trace = getActiveTraceContext();
    const entry: AuditLogEntry = stripUndefined({
      id: this.#newId(),
      type: "credential-access" as const,
      actor: fields.actor,
      relatedCredentialId: fields.credentialId,
      originAppId: fields.appId,
      details: fields.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#now(),
    });
    return new AuditLogRepository(handle).insert(entry);
  }
}

/**
 * Build the read-only {@link AdapterTokenStore} the Auth Gateway resolver uses to
 * validate a presented token per request (AT-2). Bound to the pool — validation
 * opens no transaction and writes nothing.
 */
export function buildAdapterTokenValidator(deps: {
  readonly db: Database;
  readonly rotationOverlapMs: number;
  readonly now?: () => Date;
}): AdapterTokenStore {
  const options =
    deps.now !== undefined
      ? { rotationOverlapMs: deps.rotationOverlapMs, now: deps.now }
      : { rotationOverlapMs: deps.rotationOverlapMs };
  return new AdapterTokenStore(
    new DbAdapterTokenPersistence(deps.db),
    new DbConsumerAppEligibilityReader(deps.db),
    options,
  );
}

export type { ValidateTokenResult };
