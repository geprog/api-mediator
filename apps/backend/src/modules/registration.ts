import { randomUUID } from "node:crypto";

import type { RegisterAppRequest } from "@mediator/contracts";
import type { ApiSpec, AppCapabilities, Ir, RegisteredApp } from "@mediator/domain";
import { buildIr, computeContentHash, IrError } from "@mediator/ir";

import { BadRequestError } from "../app-errors.js";
import { assertExclusionsInIr } from "./analysis-exclusions.js";
import type { UnitOfWork } from "./persistence.js";
import type { SpecRegistry } from "./spec-registry.js";

/** The result of a successful registration: the created app + its stored specs. */
export interface RegisterAppResult {
  readonly app: RegisteredApp;
  readonly specs: ApiSpec[];
}

/** The registration entry point the operator API route depends on (AR-1). */
export interface Registrar {
  register(request: RegisterAppRequest): Promise<RegisterAppResult>;
}

/** One submitted spec paired with its already-built IR + content hash. */
interface ParsedSpec {
  readonly document: Record<string, unknown>;
  readonly role: RegisterAppRequest["specs"][number]["role"];
  readonly analysisExclusions: string[];
  readonly ir: Ir;
  readonly contentHash: string;
}

export interface RegistrationServiceDeps {
  readonly unitOfWork: UnitOfWork;
  readonly specRegistry: SpecRegistry;
  /** Poll interval (ms) stamped onto capabilities when a request omits them. */
  readonly defaultPollInterval: number;
}

/**
 * The app-registration orchestration (AR-1) — an API/UI-layer concern
 * (`docs/architecture/overview.md` *Key interfaces*). It:
 *
 * 1. enforces the domain rules the request schema cannot (baseUrl-required-for-
 *    PROVIDER — OQ1; capability defaults — OQ2);
 * 2. **parses every submitted document first** (`buildIr`), so a parse failure
 *    rejects the whole request with a 400 *before any write* (AR-1 crit 7 — the
 *    reason nothing is created on a bad spec);
 * 3. runs create-app → store-credential → ingest-each-spec inside **one
 *    transaction**, so any failure persists nothing and emits no `SpecIngested`
 *    (AR-1 crit 6/7, EB-1).
 *
 * Credential material passes straight to the tx-bound `CredentialStore.store`
 * (write-only) and is never returned or logged here (CR-1/CR-2).
 */
export class RegistrationService implements Registrar {
  readonly #unitOfWork: UnitOfWork;
  readonly #specRegistry: SpecRegistry;
  readonly #defaultPollInterval: number;

  public constructor(deps: RegistrationServiceDeps) {
    this.#unitOfWork = deps.unitOfWork;
    this.#specRegistry = deps.specRegistry;
    this.#defaultPollInterval = deps.defaultPollInterval;
  }

  public async register(request: RegisterAppRequest): Promise<RegisterAppResult> {
    const capabilities = this.#resolveCapabilities(request.capabilities);
    this.#assertBaseUrlPresentForProvider(request);

    // Parse-all-first: fail fast before any write (AR-1 crit 7). A parse failure
    // here means the transaction is never opened, so no app/credential/spec is
    // created and no event is emitted.
    const parsed = await this.#parseAll(request);

    return this.#unitOfWork.run(async (stores) => {
      const app = await stores.registeredApps.create(this.#buildApp(request, capabilities));

      if (request.credential !== undefined) {
        // Write-only: store returns metadata; the secret never comes back.
        await stores.credentialStore.store(app.id, request.credential);
      }

      const specs: ApiSpec[] = [];
      for (const spec of parsed) {
        specs.push(
          await this.#specRegistry.persistIngestedSpec(
            app.id,
            {
              document: spec.document,
              ir: spec.ir,
              contentHash: spec.contentHash,
              role: spec.role,
              analysisExclusions: spec.analysisExclusions,
              capabilities,
            },
            stores,
          ),
        );
      }

      return { app, specs };
    });
  }

  #resolveCapabilities(provided: AppCapabilities | undefined): AppCapabilities {
    // OQ2: default conservatively when capabilities are omitted.
    return (
      provided ?? {
        supportsPolling: false,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: this.#defaultPollInterval,
      }
    );
  }

  #assertBaseUrlPresentForProvider(request: RegisterAppRequest): void {
    // OQ1 / AR-1 crit 3: the mediator must be able to reach a provider to
    // poll/call it, so baseUrl is required once any spec is a PROVIDER.
    const hasProvider = request.specs.some((spec) => spec.role === "PROVIDER");
    if (hasProvider && request.baseUrl === undefined) {
      throw new BadRequestError("baseUrl is required when registering a PROVIDER spec.", [
        { path: "baseUrl", message: "required when any submitted spec has role PROVIDER" },
      ]);
    }
  }

  async #parseAll(request: RegisterAppRequest): Promise<ParsedSpec[]> {
    const parsed: ParsedSpec[] = [];
    for (const [index, spec] of request.specs.entries()) {
      let ir: Ir;
      try {
        ir = await buildIr(spec.document);
      } catch (error) {
        if (error instanceof IrError) {
          throw new BadRequestError(`Spec at index ${String(index)} could not be parsed.`, [
            { path: `specs.${String(index)}.document`, message: error.message },
          ]);
        }
        throw error;
      }
      const analysisExclusions = spec.analysisExclusions ?? [];
      // SI-4 crit 4: registration-time exclusions must reference real resource
      // groups too — the same rule PATCH …/analysis-exclusions enforces.
      assertExclusionsInIr(ir, analysisExclusions, `specs.${String(index)}.analysisExclusions`);
      parsed.push({
        document: spec.document,
        role: spec.role,
        analysisExclusions,
        ir,
        contentHash: computeContentHash(spec.document),
      });
    }
    return parsed;
  }

  #buildApp(request: RegisterAppRequest, capabilities: AppCapabilities): RegisteredApp {
    return {
      id: randomUUID(),
      name: request.name,
      status: "active",
      capabilities,
      createdAt: new Date(),
      // baseUrl is absent (not `undefined`) for a consumer-only app, honoring
      // exactOptionalPropertyTypes (AR-1 crit 4).
      ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
    };
  }
}
