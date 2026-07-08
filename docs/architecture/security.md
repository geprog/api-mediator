# Security & Credential Handling

Even though the deployment model is single-tenant and self-hosted (no multi-tenant isolation required, see [overview.md](overview.md)), credential handling is not simplified to the point of being naive — the mediator holds live credentials to every app in the landscape, making the Credential Store one of its highest-value targets.

## Credential storage

- `Credential.encryptedPayload` (see [data-model.md](data-model.md)) uses **envelope encryption**: a per-credential data key, itself encrypted by a master key held by a key-management capability. This is described abstractly — the architecture does not mandate a specific vault product, only the envelope-encryption pattern and the access discipline below.
- Only the Credential Store's internal accessor can decrypt a credential, and only for the duration of a single outbound call, via the `withCredential(appId, fn)` pattern:
  - Decrypted material is never persisted in logs.
  - Decrypted material is never returned through the API/UI layer.
  - Decrypted material is never held in memory beyond the scope of that one call.

## Least privilege

The Sync Engine and Adapter Engine request credentials only for the specific app they are actively calling at that moment — never landscape-wide, and never cached across calls to different apps.

## Inbound authentication to generated adapter servers

Each consumer `RegisteredApp` (see [data-model.md](data-model.md)) is issued its own mediator-generated access token, used to authenticate its calls to its own `AdapterEndpoint`s. An Auth Gateway in front of the Adapter Server Runtime validates this token per request (see [adapter-engine.md](adapter-engine.md)). This is deliberately kept simple — one token per consumer app, no tenant hierarchy — consistent with the single-tenant deployment model, while still preventing an unauthenticated caller from invoking a live adapter that reaches into the real landscape.

## Webhook authenticity

Inbound webhooks (see [sync-engine.md](sync-engine.md)) are verified against a per-app `webhookSecret`, itself stored as a `Credential`. Unsigned or invalid-signature webhook requests are rejected before they reach the sync pipeline — they never trigger Loop Prevention, Transformation, or Outbound Call logic.

## Audit logging

Every credential access, outbound call, adapter request, and mapping decision is recorded in the Audit/Event Log (see [data-model.md](data-model.md)) — metadata only (who/what/when/status), never secret values. This is the durable, queryable record used for traceability, loop-prevention state, and conflict debugging, and it is distinct from the operational OpenTelemetry telemetry described in [observability.md](observability.md) (which is for debugging live system behavior, not for holding sensitive business records long-term).

## Summary of trust boundaries

| Boundary | Mechanism |
|---|---|
| UI/API layer → Credential Store | UI never receives raw credentials; only ever triggers actions that internally use `withCredential`. |
| Sync/Adapter engines → registered apps | Scoped, per-call credential access; least privilege by app. |
| Registered apps → mediator (webhooks) | Signature verification against `webhookSecret`. |
| New apps → their generated adapter endpoint | Per-app mediator-issued token, validated by the Auth Gateway. |
| Everything → Audit Log | Metadata-only recording; no secret material ever written to the audit trail. |
