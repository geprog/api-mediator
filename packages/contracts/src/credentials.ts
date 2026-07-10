import { z } from "zod";

/**
 * The **write-only** credential material a registration request may carry
 * (CR-1). This is the *input* wire shape only; there is deliberately **no**
 * credential response DTO anywhere in `@mediator/contracts` — credential
 * material and `Credential.encryptedPayload` never leave the Credential Store
 * (CR-2), so nothing here can echo a secret back.
 *
 * The secret is a discriminated union on `type`, mirroring the storable set that
 * `CredentialStore.store` accepts (`apiKey` | `basicAuth` | `oauth2` | `custom`).
 * `adapterToken` is **intentionally absent**: it is a Phase-5 consumer token
 * stored as a salted hash, not envelope-encrypted material, so a request that
 * submits `type: "adapterToken"` fails validation at this boundary with an error
 * naming `credential.secret.type` (CR-1 criterion 5). The shape is structurally
 * identical to `@mediator/credentials`' `CredentialMaterial`, so the backend
 * hands a validated DTO straight to `CredentialStore.store`, which re-validates.
 */
export const credentialSecretDtoSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey"), apiKey: z.string().min(1) }),
  z.object({
    type: z.literal("basicAuth"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("oauth2"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("custom"), values: z.record(z.string(), z.string()) }),
]);
export type CredentialSecretDto = z.infer<typeof credentialSecretDtoSchema>;

/** The full write-only credential input: the secret plus optional `scopes`. */
export const credentialMaterialDtoSchema = z.object({
  secret: credentialSecretDtoSchema,
  scopes: z.array(z.string()).optional(),
});
export type CredentialMaterialDto = z.infer<typeof credentialMaterialDtoSchema>;
