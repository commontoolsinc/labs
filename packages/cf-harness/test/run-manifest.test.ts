import { assertEquals, assertThrows } from "@std/assert";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { parseLoomRunManifestJson } from "../src/contracts/run-manifest.ts";

Deno.test("parseLoomRunManifestJson validates prompt-slot evidence", () => {
  const manifest = parseLoomRunManifestJson(
    JSON.stringify({
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      wishId: "W-519",
      promptSlot: {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "loom.wish", wishId: "W-519" },
        role: "direct-command",
        kernelName: "loom",
        surface: "wish-dispatch",
        subject: "W-519",
      },
    }),
  );

  assertEquals(manifest.promptSlot?.type, CFC_PROMPT_SLOT_BOUND_ATOM_TYPE);
  assertEquals(manifest.promptSlot?.source, {
    type: "loom.wish",
    wishId: "W-519",
  });
});

Deno.test("parseLoomRunManifestJson rejects malformed prompt-slot evidence", () => {
  assertThrows(
    () => parseLoomRunManifestJson(JSON.stringify([])),
    Error,
    "run manifest must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          promptSlot: [],
        }),
      ),
    Error,
    "prompt slot binding must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          promptSlot: { role: "direct-command" },
        }),
      ),
    Error,
    "unsupported prompt slot binding type",
  );
});

Deno.test("parseLoomRunManifestJson rejects invalid CFC metadata", () => {
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: [],
        }),
      ),
    Error,
    "run manifest cfc must be a JSON object",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: { enforcementMode: "bogus" },
        }),
      ),
    Error,
    "unsupported run manifest cfc.enforcementMode",
  );
  assertThrows(
    () =>
      parseLoomRunManifestJson(
        JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: { enforcementMode: "" },
        }),
      ),
    Error,
    "unsupported run manifest cfc.enforcementMode",
  );
});

Deno.test("parseLoomRunManifestJson preserves a non-secret credential owner reference", () => {
  const manifest = parseLoomRunManifestJson(JSON.stringify({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-codex",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-123",
      tenantKey: "tenant-1",
    },
  }));

  assertEquals(manifest.modelProvider, "openai-codex");
  assertEquals(manifest.credentialOwner, {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey: "loom:user-123",
    tenantKey: "tenant-1",
  });
});

Deno.test("parseLoomRunManifestJson rejects malformed provider ownership", () => {
  for (
    const credentialOwner of [
      {},
      {
        type: "cf-harness.credential-owner-ref",
        version: 1,
        ownerKey: " ",
      },
      {
        type: "cf-harness.credential-owner-ref",
        version: 1,
        ownerKey: "loom:user",
        tenantKey: "",
      },
    ]
  ) {
    assertThrows(
      () =>
        parseLoomRunManifestJson(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
          credentialOwner,
        })),
      Error,
      "invalid run manifest credentialOwner reference",
    );
  }
  assertThrows(
    () =>
      parseLoomRunManifestJson(JSON.stringify({
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        modelProvider: "codex-ish",
      })),
    Error,
    "unsupported run manifest modelProvider",
  );
});
