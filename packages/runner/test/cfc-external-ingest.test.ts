import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { stampExternalIngest } from "../src/cfc/external-ingest.ts";

const signer = await Identity.fromPassphrase("runner-cfc-external-ingest");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
};

// The Vouched Ingest Channel split-mint: a builtin-authored ExternalIngest
// provenance mark, derived only from the verified channel metadata stamped on
// the tx, that survives the runtime-minted gate while a copy smuggled into the
// payload is stripped. The toolshed/operator runtime runs CFC *disabled*, so
// the headline case proves the mark is still minted there.
describe("CFC external-ingest provenance mint (split-mint)", () => {
  const makeRuntime = (
    overrides: {
      cfcEnforcementMode?: string;
      cfcFlowLabels?: string;
      cfcWriteFloor?: string;
    } = {},
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime(
      {
        apiUrl: new URL("https://example.com"),
        storageManager,
        // Explicitly-disabled mode — the mint's hardest case (nothing else
        // marks the tx relevant) — unless a test overrides it. Not any shipped
        // host's posture: toolshed passes no CFC options and runs the
        // enforce-explicit Runtime default.
        cfcEnforcementMode: "disabled",
        cfcFlowLabels: "off",
        ...overrides,
      } as ConstructorParameters<typeof Runtime>[0],
    );
    return { storageManager, runtime };
  };

  const entriesOf = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredEntry[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const ingestEntries = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredEntry[] =>
    entriesOf(storageManager, id).filter((e) => e.origin === "external-ingest");

  const meta = (id: string, valueDigest: string) => ({
    channel: "did:key:channel",
    audience: "did:key:presenter",
    receivedAt: "2026-06-26T12:00:00.000Z",
    valueDigest,
    target: { space, id: id as never, scope: "space" as const, path: [] },
  });

  const externalIngestAtom = (valueDigest: string) => ({
    type: CFC_ATOM_TYPE.ExternalIngest,
    channel: "did:key:channel",
    audience: "did:key:presenter",
    receivedAt: "2026-06-26T12:00:00.000Z",
    valueDigest,
  });

  it("mints the mark on the ingest target even when CFC is disabled", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const { error } = await runtime.editWithRetry((tx) => {
        const cell = runtime.getCell(space, "ingest-a", undefined, tx);
        const id = cell.getAsNormalizedFullLink().id;
        stampExternalIngest(tx, meta(id, "sha256:payload-1"));
        tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, {
          hello: "world",
        });
      });
      expect(error).toBeUndefined();

      const id =
        runtime.getCell(space, "ingest-a").getAsNormalizedFullLink().id;
      const entries = ingestEntries(storageManager, id);
      expect(entries.length).toBe(1);
      expect(entries[0].label.integrity).toContainEqual(
        externalIngestAtom("sha256:payload-1"),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-mints (replaces) on a second ingest — no stale-digest accumulation", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const id =
        runtime.getCell(space, "ingest-b").getAsNormalizedFullLink().id;

      for (const [digest, payload] of [["sha256:p1", 1], ["sha256:p2", 2]]) {
        const { error } = await runtime.editWithRetry((tx) => {
          stampExternalIngest(tx, meta(id, digest as string));
          // The real append idiom: read-modify-write the whole array.
          const cell = runtime.getCell(space, "ingest-b", undefined, tx);
          const current = (cell.getRaw() as { value?: number[] })?.value ?? [];
          tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, [
            ...current,
            payload,
          ]);
        });
        expect(error).toBeUndefined();
      }

      const entries = ingestEntries(storageManager, id);
      // Exactly one mark, carrying the LATEST payload's digest — the first
      // ingest's mark must not survive with its stale digest.
      expect(entries.length).toBe(1);
      expect(entries[0].label.integrity).toContainEqual(
        externalIngestAtom("sha256:p2"),
      );
      expect(entries[0].label.integrity).not.toContainEqual(
        externalIngestAtom("sha256:p1"),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("strips a smuggled ExternalIngest from the payload while the minted mark survives", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // An attacker controls the payload and tries to forge the provenance
      // mark by declaring an ExternalIngest atom in the value's schema. The
      // payload is authored under the (unattributed, non-builtin) member
      // identity, so the runtime-minted gate must strip it.
      const forged = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              ifc: {
                integrity: [
                  cfcAtom.externalIngest(
                    "did:key:attacker-channel",
                    "did:key:attacker",
                    "1999-01-01T00:00:00.000Z",
                    "sha256:evil",
                  ),
                  "plain-claim",
                ],
              },
            },
          },
          required: ["field"],
        } satisfies JSONSchema,
        true,
      );

      const id =
        runtime.getCell(space, "ingest-forge").getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:real-payload"));
        const cell = runtime.getCell(space, "ingest-forge", forged.schema, tx);
        cell.set({ field: "hello" });
      });
      expect(error).toBeUndefined();

      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared")
        .flatMap((e) => e.label.integrity ?? []);
      // The author keeps their plain claim, but the forged ExternalIngest is
      // gone — bytes cannot mint the trusted mark.
      expect(declared).toContainEqual("plain-claim");
      expect(declared).not.toContainEqual(
        externalIngestAtom("sha256:evil"),
      );
      expect(
        declared.some((a) =>
          (a as { type?: string })?.type === CFC_ATOM_TYPE.ExternalIngest
        ),
      ).toBe(false);

      // The ONLY ExternalIngest mark on the doc is the runtime-minted one,
      // carrying the operator's verified metadata — not the attacker's.
      const ingest = ingestEntries(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(ingest).toEqual([externalIngestAtom("sha256:real-payload")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the mark even when the payload fails schema verification", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // A field carrying an ifc claim the runner does not implement makes
      // verifyInputRequirements fail for this write target. Before the fix that
      // failure `continue`d past the ingest mint, silently dropping the mark on
      // a committing (disabled/observe) tx. The mark is runtime-authored
      // provenance, orthogonal to whether the payload satisfies its schema, so
      // it must still persist here (enforcing modes still abort the whole tx via
      // the recorded reason, so nothing — payload or mark — lands there).
      const unsupported = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              // A valid confidentiality claim (would produce a declared label)
              // plus `transformation`, which the runner does not implement (so
              // verifyInputRequirements fails for this target).
              ifc: { confidentiality: ["secret"], transformation: true },
            },
          },
          required: ["field"],
        } as JSONSchema,
        true,
      );

      const id = runtime.getCell(space, "ingest-unsupported")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:despite-failure"));
        const cell = runtime.getCell(
          space,
          "ingest-unsupported",
          unsupported.schema,
          tx,
        );
        cell.set({ field: "hello" });
      });
      // Disabled mode commits despite the recorded verification reason.
      expect(error).toBeUndefined();

      const marks = entriesOf(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(marks).toContainEqual(
        externalIngestAtom("sha256:despite-failure"),
      );

      // ...but the payload's own (unverified) declared policy label did NOT
      // persist — a failed write must not store unverified policy metadata.
      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared");
      expect(declared.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the mark even when the payload fails the write floor", async () => {
    // Same invariant as the schema-verification case, for the D3 write floor:
    // an ingest payload violating a requiredIntegrity floor records the reason
    // (enforcing modes abort the whole tx), but on a committing (disabled)
    // runtime the runtime-authored mark still persists and only the payload's
    // declared policy label is dropped. Exercises the floor's ingest-target
    // branch (ingestVerificationFailed instead of skipping the mint).
    const { storageManager, runtime } = makeRuntime({
      cfcWriteFloor: "enforce",
    });
    try {
      const floored = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              ifc: { requiredIntegrity: ["ingest-endorsement"] },
            },
          },
          required: ["field"],
        } as JSONSchema,
        true,
      );

      const id = runtime.getCell(space, "ingest-floored")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:floor-miss"));
        const cell = runtime.getCell(
          space,
          "ingest-floored",
          floored.schema,
          tx,
        );
        cell.set({ field: "unendorsed" });
      });
      // Disabled enforcement commits despite the recorded floor reason.
      expect(error).toBeUndefined();

      const marks = entriesOf(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(marks).toContainEqual(externalIngestAtom("sha256:floor-miss"));

      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared");
      expect(declared.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not mint a mark when the tx is not stamped", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const { error } = await runtime.editWithRetry((tx) => {
        const cell = runtime.getCell(space, "ingest-c", undefined, tx);
        const id = cell.getAsNormalizedFullLink().id;
        tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, {
          hello: "world",
        });
      });
      expect(error).toBeUndefined();

      const id =
        runtime.getCell(space, "ingest-c").getAsNormalizedFullLink().id;
      expect(ingestEntries(storageManager, id).length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
