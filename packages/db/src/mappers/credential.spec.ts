import type { Credential } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapCredentialMetadataRow,
  toCredentialInsert,
  type CredentialMetadataRow,
} from "./credential.js";

const lastRotatedAt = new Date("2026-07-10T00:00:00.000Z");

describe("toCredentialInsert", () => {
  it("carries encryptedPayload IN on the write path", () => {
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
    });
  });
});

describe("mapCredentialMetadataRow", () => {
  it("returns metadata only — never a payload field", () => {
    const row: CredentialMetadataRow = {
      id: "cred-1",
      type: "apiKey",
      scopes: ["read"],
      lastRotatedAt,
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
  });
});
