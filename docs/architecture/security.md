# Security & Credential Handling

Even though the deployment model is single-tenant and self-hosted (no multi-tenant isolation required, see [overview.md](overview.md)), credential handling is not simplified to the point of being naive — the mediator holds live credentials to every app in the landscape, making the Credential Store one of its highest-value targets.

## Operator authentication & authorization

The mediator's own API/UI is the most privileged surface in the system: registering apps, approving mappings, composing adapter endpoints, and enabling sync rules are the actions everything else trusts. Access requires an authenticated **operator identity**, via a pluggable authentication provider — the organization's SSO/OIDC in the typical self-hosted deployment, with local accounts as a fallback. Authorization is deliberately minimal, consistent with single-tenancy — two roles, no tenant hierarchy:

- **operator** — may mutate: register/disable/deregister apps, review and approve mappings, compose endpoints, enable/disable sync rules, manage credentials (at the metadata level — raw secrets are still never returned, see below).
- **viewer** — read-only: landscape graph, proposals, audit log, dashboards.

Every mutating action records the authenticated identity — `approvedBy` on `ApprovedMapping`, the actor on audit entries (see [data-model.md](data-model.md)). Approval accountability is only meaningful if those identities are real, which is why an unauthenticated deployment mode does not exist.

## Credential storage

- `Credential.encryptedPayload` (see [data-model.md](data-model.md)) uses **envelope encryption**: a per-credential data key, itself encrypted by a master key held by a key-management capability. This is described abstractly — the architecture does not mandate a specific vault product, only the envelope-encryption pattern and the access discipline below.
- Only the Credential Store's internal accessor can decrypt a credential, and only for the duration of a single outbound call, via the `withCredential(appId, fn)` pattern:
  - Decrypted material is never persisted in logs.
  - Decrypted material is never returned through the API/UI layer.
  - Decrypted material is never held in memory beyond the scope of that one call.
- OAuth2 token lifecycle is handled entirely *inside* the Credential Store: refresh tokens are stored envelope-encrypted, and the store refreshes access tokens internally (persisting updated tokens re-encrypted) — `withCredential` hands the caller a currently-valid access token, and callers never see or trigger refresh flows themselves. The "never held beyond the scope of one call" rule governs what *callers* may do with secret material; the store's internal lifecycle management is what makes that rule practical for expiring credentials.

## Least privilege

The Sync Engine and Adapter Engine request credentials only for the specific app they are actively calling at that moment — never landscape-wide, and never cached across calls to different apps.

## Inbound authentication to generated adapter servers

Each consumer `RegisteredApp` (see [data-model.md](data-model.md)) is issued its own mediator-generated access token, used to authenticate its calls to its own `AdapterEndpoint`s. An Auth Gateway in front of the Adapter Server Runtime validates this token per request (see [adapter-engine.md](adapter-engine.md)). This is deliberately kept simple — one token per consumer app, no tenant hierarchy — consistent with the single-tenant deployment model, while still preventing an unauthenticated caller from invoking a live adapter that reaches into the real landscape. The token has a full `Credential` lifecycle rather than being an unmodeled string (`type = adapterToken`, see [data-model.md](data-model.md)): generated at registration and returned exactly once; stored only as a salted hash, since validation needs equality, never the original value; rotated with an overlap window — old and new both valid until the consumer confirms cutover, tracked via `lastRotatedAt`; and revoked implicitly when the consumer app is disabled or deregistered.

## Webhook authenticity

Inbound webhooks (see [sync-engine.md](sync-engine.md)) are verified against a per-app `webhookSecret`, itself stored as a `Credential`; the signature scheme is configured per app at registration (HMAC over the body plus a timestamp header being the common shape — external apps do not share one convention). Signatures cover a timestamp, and requests older than a configurable tolerance are rejected — replaying a captured webhook payload later fails even with a valid signature. Unsigned, invalid-signature, or stale requests are rejected before they reach the sync pipeline — they never trigger Identity Resolution, Loop Prevention, Transformation, or Outbound Call logic.

Apps that cannot sign webhooks at all (`capabilities.webhookVerification = none`, see [data-model.md](data-model.md)) get a deliberately reduced trust level instead of a silent exception: their webhook bodies are never treated as content, only as triggers for an immediate authenticated poll of the source — the unauthenticated inbound channel can influence *when* the mediator reads, never *what* it believes — and trigger handling is rate-limited per app, so a forged flood cannot amplify into outbound traffic (see [sync-engine.md](sync-engine.md)).

## LLM data boundary

The Mapping Engine sends only specification *metadata* to the configured LLM provider: resource, operation, and schema names, descriptions, types, and reviewer mapping feedback (see [mapping-engine.md](mapping-engine.md)). **Live payload data flowing through the Sync and Adapter Engines is never sent to an LLM** — mapping *detection* (LLM-assisted, metadata only) and mapping *execution* (deterministic transforms over real data) are strictly separated stages. Organizations whose spec descriptions are themselves sensitive can run a self-hosted model behind the same provider interface.

## Transformation expression sandboxing

The `expression` transform on a `FieldMapping` (see [data-model.md](data-model.md)) executes in a sandboxed, non-Turing-complete expression evaluator: no I/O, no network, no loops or recursion, bounded evaluation time and memory — data in, data out. Expressions are human-reviewed at approval like every other mapping element, but the sandbox is the enforcement; review is not the security boundary for LLM-suggested code.

## Audit logging

Every credential access, outbound call, adapter request, and mapping decision is recorded in the Audit/Event Log (see [data-model.md](data-model.md)) — metadata only (who/what/when/status), never secret values. This is the durable, queryable record used for traceability, loop-prevention state, and conflict debugging, and it is distinct from the operational OpenTelemetry telemetry described in [observability.md](observability.md) (which is for debugging live system behavior, not for holding sensitive business records long-term).

## Summary of trust boundaries

| Boundary | Mechanism |
|---|---|
| Humans → mediator API/UI | Authenticated operator identity (SSO/OIDC or local accounts); `operator` vs. `viewer` roles; every mutation attributed. |
| UI/API layer → Credential Store | UI never receives raw credentials; only ever triggers actions that internally use `withCredential`. |
| Mapping Engine → LLM provider | Spec metadata only — live payload data never leaves the sync/adapter pipeline. |
| Mapping transforms → runtime | `expression` transforms run in a sandboxed, non-Turing-complete evaluator. |
| Sync/Adapter engines → registered apps | Scoped, per-call credential access; least privilege by app. |
| Registered apps → mediator (webhooks) | Signature verification against `webhookSecret`. |
| New apps → their generated adapter endpoint | Per-app mediator-issued token, validated by the Auth Gateway. |
| Everything → Audit Log | Metadata-only recording; no secret material ever written to the audit trail. |
