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
import type { NormalizedFullLink } from "../src/link-types.ts";
import type {
  IExtendedStorageTransaction,
  Labels,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example safe probing test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const promptInjectionRiskAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "PROMPT_INJECTION_RISK_UNSCREENED",
  source: "ref:report-1",
} as const;

const promptInfluenceAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "PROMPT_INFLUENCE",
  source: "ref:report-1",
} as const;

const injectionSafeAtom = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
  stage: "value",
  detectorProfile: "pi-screen-v3",
} as const;

const reportSchema = {
  type: "string",
  ifc: {
    classification: [
      [userAliceAtom],
      [promptInjectionRiskAtom],
      [promptInfluenceAtom],
    ],
  },
} as const satisfies JSONSchema;

const wordCountSchema = {
  type: "number",
  ifc: {
    integrity: [injectionSafeAtom],
    declassify: {
      confidentialityPre: [promptInjectionRiskAtom],
      integrityPre: [injectionSafeAtom],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC worked example: safe probing", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  async function readLabelsForCell(
    cell: { getAsNormalizedFullLink: () => NormalizedFullLink },
  ): Promise<Record<string, Labels>> {
    const readTx = runtime.edit();
    const raw = readTx.readOrThrow(
      cfcLabelsAddress(cell.getAsNormalizedFullLink()),
    );
    await readTx.abort();
    return normalizePersistedLabels(raw);
  }

  it("clears material-risk caveats for a numeric probe while preserving prompt influence", async () => {
    const report = runtime.getCell(
      space,
      "safe-probing-report",
      reportSchema,
      tx,
    );
    report.withTx(tx).set("Malicious instructions hidden in a report");
    await prepareCfcCommitIfNeeded(tx);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const wordCount = runtime.getCell(
      space,
      "safe-probing-word-count",
      wordCountSchema,
      tx,
    );
    report.withTx(tx).get();
    wordCount.withTx(tx).set(42);

    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readLabelsForCell(wordCount);
    expect(labels["/"]?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [promptInfluenceAtom],
      ]),
    );
    expect(labels["/"]?.classification).toHaveLength(2);
    expect(labels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(injectionSafeAtom),
      ]),
    );
  });
});
