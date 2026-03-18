import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example fact check test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const publicAudienceAtom = {
  type: "https://commonfabric.org/cfc/atom/Audience",
  kind: "public",
} as const;

const factCheckedAtom = {
  type: "https://commonfabric.org/cfc/atom/FactChecked",
  checker: "Builtin(fact-check)",
  version: "test-v1",
} as const;

const sourcesDisclosedAtom = {
  type: "https://commonfabric.org/cfc/atom/SourcesDisclosed",
  sourceSetHash: "sha256:source-set-1",
} as const;

const sourceSchema = {
  type: "string",
  ifc: { classification: [userAliceAtom] },
} as const satisfies JSONSchema;

const factCheckOutputSchema = {
  type: "string",
  ifc: {
    classification: [publicAudienceAtom],
    declassify: {
      confidentialityPre: [userAliceAtom],
      integrityPre: ["fact-check-proof"],
      addAlternatives: [publicAudienceAtom],
      addIntegrity: [factCheckedAtom, sourcesDisclosedAtom],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC worked example: fact-check assurance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  async function seedValueWithLabels(
    id: URI,
    value: unknown,
    labels: Labels,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as never);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, { "/": labels });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  async function readLabels(id: URI): Promise<Record<string, Labels>> {
    const tx = runtime.edit();
    const raw = tx.readOrThrow({
      ...cfcLabelsAddress({
        space,
        id,
        type: "application/json",
      }),
    });
    await tx.abort();
    return normalizePersistedLabels(raw);
  }

  it("adds structured confidentiality and integrity evidence through policy rewrite", async () => {
    const source = runtime.getCell<string>(
      space,
      "fact-check-worked-example-source",
      undefined,
    );

    await seedValueWithLabels(
      source.getAsNormalizedFullLink().id,
      "Claim text",
      {
        classification: [userAliceAtom],
        integrity: ["fact-check-proof"],
      },
    );

    const tx = runtime.edit();
    const freshSource = runtime.getCell<string>(
      space,
      "fact-check-worked-example-source",
      undefined,
      tx,
    );
    const freshTarget = runtime.getCell<string>(
      space,
      "fact-check-worked-example-target",
      undefined,
      tx,
    );
    const value = freshSource.withTx(tx).asSchema(sourceSchema).get() ?? "";
    freshTarget.withTx(tx).asSchema(factCheckOutputSchema).set(value);

    await prepareCfcCommitIfNeeded(tx);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readLabels(freshTarget.getAsNormalizedFullLink().id);
    expect(labels["/"]?.classification).toEqual([[publicAudienceAtom]]);
    expect(labels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        "fact-check-proof",
        factCheckedAtom,
        sourcesDisclosedAtom,
      ]),
    );
  });
});
