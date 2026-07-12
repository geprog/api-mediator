/**
 * `@mediator/contracts` — the operator-API request/response DTO schemas (Zod)
 * and their inferred types, shared by the backend routes and the frontend client
 * with no codegen.
 *
 * DTOs are kept distinct from `@mediator/domain` entities wherever the wire shape
 * differs: a domain `Date` becomes an ISO-8601 string, `ApiSpec.rawDocument` is
 * never exposed by a metadata/list DTO, and credential material / `encryptedPayload`
 * appear in **no** response schema (CR-2). The package depends only on
 * `@mediator/domain` (IR + enums + shared sub-shapes) and `zod`, so the frontend
 * can import it without pulling in any backend/persistence code.
 */

export {
  RESOURCE_BINDING_REF_KINDS,
  errorResponseSchema,
  isoDateTimeSchema,
  resourceBindingRefKindSchema,
  validationIssueSchema,
  type ErrorResponse,
  type ResourceBindingRefKind,
  type ValidationIssue,
} from "./common.js";

export {
  credentialMaterialDtoSchema,
  credentialSecretDtoSchema,
  type CredentialMaterialDto,
  type CredentialSecretDto,
} from "./credentials.js";

export {
  apiSpecMetadataDtoSchema,
  appListResponseSchema,
  appSpecsResponseSchema,
  openApiDocumentSchema,
  registerAppRequestSchema,
  registerAppResponseSchema,
  registerSpecRequestSchema,
  registeredAppDtoSchema,
  type ApiSpecMetadataDto,
  type AppListResponse,
  type AppSpecsResponse,
  type RegisterAppRequest,
  type RegisterAppResponse,
  type RegisterSpecRequest,
  type RegisteredAppDto,
} from "./apps.js";

export {
  irResponseSchema,
  previewParseRequestSchema,
  previewParseResponseSchema,
  resourceGroupSummarySchema,
  updateAnalysisExclusionsRequestSchema,
  updateAnalysisExclusionsResponseSchema,
  type IrResponse,
  type PreviewParseRequest,
  type PreviewParseResponse,
  type ResourceGroupSummary,
  type UpdateAnalysisExclusionsRequest,
  type UpdateAnalysisExclusionsResponse,
} from "./specs.js";

export {
  resourceBindingDtoSchema,
  resourceBindingRefDtoSchema,
  resourceBindingsResponseSchema,
  updateResourceBindingRequestSchema,
  updateResourceBindingResponseSchema,
  type ResourceBindingDto,
  type ResourceBindingRefDto,
  type ResourceBindingsResponse,
  type UpdateResourceBindingRequest,
  type UpdateResourceBindingResponse,
} from "./resource-bindings.js";

export {
  analyzeResourcePairRequestSchema,
  analyzeResourcePairResponseSchema,
  approveProposalRequestSchema,
  approveProposalResponseSchema,
  approvedMappingRefDtoSchema,
  identityKeyConfirmationSchema,
  mappingProposalDetailResponseSchema,
  mappingProposalItemDtoSchema,
  mappingProposalListResponseSchema,
  mappingProposalSummaryDtoSchema,
  operationOverrideSchema,
  proposalShortlistDtoSchema,
  recordProposalItemDecisionRequestSchema,
  recordProposalItemDecisionResponseSchema,
  type AnalyzeResourcePairRequest,
  type AnalyzeResourcePairResponse,
  type ApproveProposalRequest,
  type ApproveProposalResponse,
  type ApprovedMappingRefDto,
  type IdentityKeyConfirmationDto,
  type MappingProposalDetailResponse,
  type MappingProposalItemDto,
  type MappingProposalListResponse,
  type MappingProposalSummaryDto,
  type OperationOverrideDto,
  type ProposalShortlistDto,
  type RecordProposalItemDecisionRequest,
  type RecordProposalItemDecisionResponse,
} from "./mapping-proposals.js";
