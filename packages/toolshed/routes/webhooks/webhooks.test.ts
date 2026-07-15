import { afterAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import { memory as memoryProvider } from "@/routes/storage/memory.ts";
import { sha256 } from "@/lib/sha2.ts";
import { linkRefPayloadToString } from "@commonfabric/runner/shared";
import {
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  verifyWebhookSecret,
  webhookEntityId,
} from "./webhooks.utils.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

afterAll(async () => {
  await memoryProvider.close();
});

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
      const ids = new Set(
        Array.from({ length: 100 }, () => generateWebhookId()),
      );
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
    it("extracts space from an fcl1: cell link", () => {
      const cellLink = linkRefPayloadToString({
        id: "of:bafe123",
        space: "did:key:z6Mktest123",
        path: ["webhooks", "github"],
      });
      // Sanity: it really is the fcl1: wire form, not raw JSON.
      expect(cellLink.startsWith("fcl1:")).toBe(true);
      const space = extractSpaceFromCellLink(cellLink);
      expect(space).toBe("did:key:z6Mktest123");
    });

    it("throws for a string without the fcl1: prefix", () => {
      expect(() => extractSpaceFromCellLink("not json")).toThrow();
      expect(() => extractSpaceFromCellLink(JSON.stringify({}))).toThrow();
    });

    it("throws for missing space", () => {
      const cellLink = linkRefPayloadToString({ id: "of:bafe123" });
      expect(() => extractSpaceFromCellLink(cellLink)).toThrow(
        "Cell link missing space",
      );
    });
  });

  describe("webhookEntityId", () => {
    it("produces deterministic entity IDs", async () => {
      const id1 = await webhookEntityId("wh_test123");
      const id2 = await webhookEntityId("wh_test123");
      expect(id1).toBe(id2);
    });

    it("starts with of: prefix", async () => {
      const id = await webhookEntityId("wh_test123");
      expect(id.startsWith("of:")).toBe(true);
    });

    it("produces different IDs for different webhooks", async () => {
      const id1 = await webhookEntityId("wh_abc");
      const id2 = await webhookEntityId("wh_xyz");
      expect(id1).not.toBe(id2);
    });

    it("contains a 64-char hex hash after prefix", async () => {
      const id = await webhookEntityId("wh_test123");
      const hash = id.slice(3); // strip "of:"
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("uses the cf webhook salt", async () => {
      const id = await webhookEntityId("wh_test123");
      expect(id).toBe(`of:${await sha256("cf:webhook:wh_test123")}`);
    });
  });
});
