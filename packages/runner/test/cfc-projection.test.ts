import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-projection");

// §8.3 projection claims (spec cfc/08-03-projection-semantics.md): a field
// copied out of a structured source inherits the source's confidentiality in
// full (§8.3.1) and carries the source's integrity SCOPED to the projected
// path (§8.3.2) — the projected value can never claim whole-object integrity,
// and atoms that cannot express the scoping (string atoms, provenance-class
// evidence) are dropped, fail-closed.
describe("CFC projection claims", () => {
  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    return { runtime, storageManager };
  };

  const readPersistedEntries = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    persistedId: string,
  ) => {
    const replica = storageManager.open(signer.did()).replica as unknown as {
      getDocument(id: string): {
        value?: unknown;
        cfc?: {
          labelMap?: {
            entries: Array<{
              path: string[];
              label: {
                confidentiality?: unknown[];
                integrity?: unknown[];
              };
            }>;
          };
        };
      } | undefined;
    };
    return replica.getDocument(persistedId)?.cfc?.labelMap?.entries;
  };

  const gpsSchema = {
    type: "object",
    properties: {
      measurement: {
        type: "object",
        properties: {
          lat: { type: "number" },
          long: { type: "number" },
        },
        ifc: {
          confidentiality: ["secret"],
          integrity: [
            { type: "GPSMeasurement", device: "test-device" },
            // String atoms cannot carry a `scope` binding, so a projection
            // must drop them rather than let the field claim whole-object
            // integrity.
            "gps-verified",
          ],
        },
      },
      latitude: {
        type: "number",
        ifc: { projection: { from: "/measurement", path: "/lat" } },
      },
    },
    required: ["measurement", "latitude"],
  } as const satisfies JSONSchema;

  it("carries confidentiality and scoped integrity when satisfied", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-satisfied",
        gpsSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77, long: -122.41 },
        latitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const entries = readPersistedEntries(storageManager, persistedId);
      const entry = entries?.find((e) =>
        e.path.length === 1 && e.path[0] === "latitude"
      );
      expect(entry).toBeDefined();
      // §8.3.1: confidentiality inherited unchanged.
      expect(entry?.label.confidentiality).toEqual(["secret"]);
      // §8.3.2: integrity carried scoped to the projected path; the string
      // atom is dropped (no scoping representation).
      expect(entry?.label.integrity).toEqual([
        {
          type: "GPSMeasurement",
          device: "test-device",
          scope: { projection: "/lat" },
        },
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a projection claim when the projected value diverges", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-reject",
        gpsSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77, long: -122.41 },
        latitude: 1.23,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "projection claim failed at /latitude",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a projection claim on an array-item (wildcard) path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-wildcard",
        {
          type: "object",
          properties: {
            measurements: {
              type: "array",
              items: {
                type: "object",
                properties: { lat: { type: "number" } },
                ifc: { confidentiality: ["secret"] },
              },
            },
            latitudes: {
              type: "array",
              items: {
                type: "number",
                ifc: {
                  projection: { from: "/measurements", path: "/0/lat" },
                },
              },
            },
          },
          required: ["measurements", "latitudes"],
        } as const satisfies JSONSchema,
        tx,
      );

      cell.set({
        measurements: [{ lat: 37.77 }],
        latitudes: [37.77],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "projection claim under an array wildcard is unsupported",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a malformed projection claim", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-projection-malformed",
        {
          type: "object",
          properties: {
            measurement: {
              type: "object",
              properties: { lat: { type: "number" } },
              ifc: { confidentiality: ["secret"] },
            },
            latitude: {
              type: "number",
              // Missing `path` — the authored type surface rejects this at
              // compile time, but a schema arriving from storage or the wire
              // is not typed, so the claim must fail closed at commit, not
              // silently skip verification.
              ifc: { projection: { from: "/measurement" } },
            },
          },
          required: ["measurement", "latitude"],
        } as unknown as JSONSchema,
        tx,
      );

      cell.set({
        measurement: { lat: 37.77 },
        latitude: 37.77,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "malformed projection claim at /latitude",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
