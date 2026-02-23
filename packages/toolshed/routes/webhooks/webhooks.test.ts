import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import {
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  verifyWebhookSecret,
} from "./webhooks.utils.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("Webhook Utilities", () => {
  describe("generateWebhookId", () => {
    it("generates an ID with wh_ prefix", () => {
      const id = generateWebhookId();
      expect(id.startsWith("wh_")).toBe(true);
    });

    it("generates an ID with correct length (wh_ + 20 chars)", () => {
      const id = generateWebhookId();
      expect(id.length).toBe(23); // "wh_" (3) + 20
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateWebhookId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("generateWebhookSecret", () => {
    it("generates a secret with whsec_ prefix", () => {
      const { secret } = generateWebhookSecret();
      expect(secret.startsWith("whsec_")).toBe(true);
    });

    it("returns a hash promise that resolves to hex string", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique secrets", () => {
      const secrets = new Set(
        Array.from({ length: 100 }, () => generateWebhookSecret().secret),
      );
      expect(secrets.size).toBe(100);
    });
  });

  describe("verifyWebhookSecret", () => {
    it("returns true for matching secret", async () => {
      const { secret, hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret(secret, hash);
      expect(result).toBe(true);
    });

    it("returns false for wrong secret", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret("whsec_wrong", hash);
      expect(result).toBe(false);
    });

    it("returns false for empty secret", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret("", hash);
      expect(result).toBe(false);
    });
  });

  describe("extractSpaceFromCellLink", () => {
    it("extracts space from valid cell link", () => {
      const cellLink = JSON.stringify({
        "/": {
          "link-v0.1": {
            id: "of:bafe123",
            space: "did:key:z6Mktest123",
            path: ["webhooks", "github"],
          },
        },
      });
      const space = extractSpaceFromCellLink(cellLink);
      expect(space).toBe("did:key:z6Mktest123");
    });

    it("throws for invalid JSON", () => {
      expect(() => extractSpaceFromCellLink("not json")).toThrow();
    });

    it("throws for missing link data", () => {
      expect(() => extractSpaceFromCellLink(JSON.stringify({}))).toThrow(
        "Invalid cell link format",
      );
    });

    it("throws for missing space", () => {
      const cellLink = JSON.stringify({
        "/": {
          "link-v0.1": {
            id: "of:bafe123",
          },
        },
      });
      expect(() => extractSpaceFromCellLink(cellLink)).toThrow(
        "Cell link missing space",
      );
    });
  });
});
