import type { Credential } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapCredentialMetadataRow,
  toCredentialInsert,
  type CredentialMetadataRow,
} from "./credential.js";

const lastRotatedAt = new Date("2026-07-10T00:00:00.000Z");

describe("toCredentialInsert", () => {
  it("carries encryptedPayload IN on the write path; an absent validUntil is NULL", () => {
    const cred: Credential = {
      id: "cred-1",
      appId: "app-1",
      type: "apiKey",
      encryptedPayload: "envelope:opaque-ciphertext",
      scopes: ["read"],
      lastRotatedAt,
    };

    expect(toCredentialInsert(cred)).toStrictEqual({
      id: "cred-1",
      appId: "app-1",
      type: "apiKey",
      encryptedPayload: "envelope:opaque-ciphertext",
      scopes: ["read"],
      lastRotatedAt,
      validUntil: null,
    });
  });

  it("persists a present validUntil (AD-3.3 rotation bound)", () => {
    const validUntil = new Date("2026-07-21T00:00:00.000Z");
    const cred: Credential = {
      id: "tok-1",
      appId: "app-1",
      type: "adapterToken",
      encryptedPayload: "scrypt$16384$8$1$64$c2FsdA==$aGFzaA==",
      scopes: [],
      lastRotatedAt,
      validUntil,
    };
    expect(toCredentialInsert(cred).validUntil).toEqual(validUntil);
  });
});

describe("mapCredentialMetadataRow", () => {
  it("returns metadata only — never a payload field; NULL validUntil is absent", () => {
    const row: CredentialMetadataRow = {
      id: "cred-1",
      type: "apiKey",
      scopes: ["read"],
      lastRotatedAt,
      validUntil: null,
    };

    const metadata = mapCredentialMetadataRow(row);

    expect(metadata).toStrictEqual({
      id: "cred-1",
      type: "apiKey",
      scopes: ["read"],
      lastRotatedAt,
    });
    // The write-only invariant, asserted structurally: no payload key at all.
    expect(Object.keys(metadata)).not.toContain("encryptedPayload");
    // An unbounded token's validUntil is an ABSENT key, not present-null.
    expect(metadata).not.toHaveProperty("validUntil");
  });

  it("surfaces a present validUntil as queryable rotation metadata (AD-3.3)", () => {
    const validUntil = new Date("2026-07-21T00:00:00.000Z");
    const metadata = mapCredentialMetadataRow({
      id: "tok-1",
      type: "adapterToken",
      scopes: [],
      lastRotatedAt,
      validUntil,
    });
    expect(metadata.validUntil).toEqual(validUntil);
  });
});
