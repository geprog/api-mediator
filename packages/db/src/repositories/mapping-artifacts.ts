import type {
  ConflictPolicy,
  FieldMapping,
  OperationMapping,
  ParameterMapping,
} from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapFieldMappingRow, toFieldMappingInsert } from "../mappers/field-mapping.js";
import { mapOperationMappingRow, toOperationMappingInsert } from "../mappers/operation-mapping.js";
import { mapParameterMappingRow, toParameterMappingInsert } from "../mappers/parameter-mapping.js";
import { fieldMapping, operationMapping, parameterMapping } from "../schema.js";

/**
 * The full child set of one `ApprovedMapping`: its `FieldMapping`s,
 * `OperationMapping`s, and (consumer-provider only) `ParameterMapping`s. A
 * `ParameterMapping.operationMappingId` must reference an `OperationMapping.id`
 * present in `operationMappings` (the Approval Service builds them together).
 */
export interface MappingArtifacts {
  readonly fieldMappings: readonly FieldMapping[];
  readonly operationMappings: readonly OperationMapping[];
  readonly parameterMappings: readonly ParameterMapping[];
}

/**
 * Persistence for an `ApprovedMapping`'s child correspondences. Constructor-bound
 * to a {@link DbHandle} so the child writes compose inside the approve
 * transaction.
 *
 * The approve action **reconciles** the whole child set to the currently
 * accepted/edited items via {@link replaceChildren}: the child rows are wholly
 * owned by their `ApprovedMapping` (nothing else references their ids — the Sync/
 * Adapter engines select by content, not child id), so replacing them wholesale is
 * safe and keeps the persisted set an exact projection of the current review state.
 */
export class MappingArtifactsRepository {
  public constructor(private readonly db: DbHandle) {}

  /** The `FieldMapping`s of one `ApprovedMapping`. */
  public async listFieldMappings(mappingId: string): Promise<FieldMapping[]> {
    const rows = await this.db
      .select()
      .from(fieldMapping)
      .where(eq(fieldMapping.mappingId, mappingId));
    return rows.map(mapFieldMappingRow);
  }

  /**
   * Set (or clear) one peer-peer `FieldMapping`'s `conflictPolicy` override
   * (SA-1.1). `manual-resolve` forces the field's conflict to surface for manual
   * resolution instead of auto-resolving; `null` clears the override back to the
   * default (last-write-wins / observation-order auto-resolution). The existing
   * `conflict_policy` column — no migration. The caller (the SA-1 config service)
   * verifies the field belongs to the rule's mapping first.
   */
  public async setFieldMappingConflictPolicy(
    fieldMappingId: string,
    conflictPolicy: ConflictPolicy | null,
  ): Promise<void> {
    await this.db
      .update(fieldMapping)
      .set({ conflictPolicy })
      .where(eq(fieldMapping.id, fieldMappingId));
  }

  /** The `OperationMapping`s of one `ApprovedMapping`. */
  public async listOperationMappings(mappingId: string): Promise<OperationMapping[]> {
    const rows = await this.db
      .select()
      .from(operationMapping)
      .where(eq(operationMapping.mappingId, mappingId));
    return rows.map(mapOperationMappingRow);
  }

  /**
   * The `ParameterMapping`s of one `ApprovedMapping` — joined through their
   * `OperationMapping` parents, since a `ParameterMapping` references only its
   * operation pairing, not the mapping directly.
   */
  public async listParameterMappings(mappingId: string): Promise<ParameterMapping[]> {
    const rows = await this.db
      .select({ parameter: parameterMapping })
      .from(parameterMapping)
      .innerJoin(operationMapping, eq(parameterMapping.operationMappingId, operationMapping.id))
      .where(eq(operationMapping.mappingId, mappingId));
    return rows.map((row) => mapParameterMappingRow(row.parameter));
  }

  /**
   * Replace **all** child rows of `mappingId` with `artifacts`, in one transaction
   * (delete-then-insert). Operation children are deleted first, cascading their
   * `ParameterMapping`s; the new operations are inserted before their parameters so
   * the `operation_mapping_id` foreign keys resolve.
   */
  public async replaceChildren(mappingId: string, artifacts: MappingArtifacts): Promise<void> {
    await this.db.delete(fieldMapping).where(eq(fieldMapping.mappingId, mappingId));
    // Deleting the operations cascades their parameter_mapping children.
    await this.db.delete(operationMapping).where(eq(operationMapping.mappingId, mappingId));

    if (artifacts.fieldMappings.length > 0) {
      await this.db.insert(fieldMapping).values(artifacts.fieldMappings.map(toFieldMappingInsert));
    }
    if (artifacts.operationMappings.length > 0) {
      await this.db
        .insert(operationMapping)
        .values(artifacts.operationMappings.map(toOperationMappingInsert));
    }
    if (artifacts.parameterMappings.length > 0) {
      await this.db
        .insert(parameterMapping)
        .values(artifacts.parameterMappings.map(toParameterMappingInsert));
    }
  }
}
