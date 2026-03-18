import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc policy acting user variable test",
);
const space = signer.did();
const bobDid = "did:key:bob-policy-acting-user";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const viewerAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/Viewer",
  subject: space,
} as const;

const sourceSchema = {
  type: "string",
  ifc: {
    classification: [userAliceAtom],
  },
} as const satisfies JSONSchema;

const actingUserPolicySchema = {
  type: "string",
  ifc: {
    declassify: {
      preCondition: {
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: { var: "$actingUser" },
        }],
      },
      postCondition: {
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/Viewer",
          subject: { var: "$actingUser" },
        }],
      },
    },
  },
} as const satisfies JSONSchema;

describe("CFC policy acting-user variables", () => {
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
    await storageManager.close();
  });

  async function readPersistedLabels(id: `${string}:${string}`) {
    const tx = runtime.edit();
    const raw = tx.readOrThrow(cfcLabelsAddress({
      space,
      id,
      type: "application/json",
    }));
    await tx.abort();
    return normalizePersistedLabels(raw);
  }

  function clauseKeys(labels: Record<string, Labels>): string[] {
    const clause = labels["/"]?.classification?.[0];
    if (!Array.isArray(clause)) {
      return [];
    }
    return clause.map((atom: unknown) => JSON.stringify(atom)).sort();
  }

  it("binds $actingUser into policy preconditions and synthesized output atoms", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<string>(
      space,
      "cfc-policy-acting-user-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<string>(
      space,
      "cfc-policy-acting-user-target",
      undefined,
      tx,
    );
    source.set("visible to acting user");
    tx.writeOrThrow(cfcLabelsAddress({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
    }), {
      "/": {
        classification: [userAliceAtom],
        integrity: [],
      } satisfies Labels,
    });
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const value = source.withTx(tx).asSchema(sourceSchema).get() ?? "";
    target.withTx(tx).asSchema(actingUserPolicySchema).set(value);

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(target.getAsNormalizedFullLink().id);
    expect(clauseKeys(labels)).toEqual(
      [JSON.stringify(userAliceAtom), JSON.stringify(viewerAliceAtom)].sort(),
    );
  });

  it("fails closed when $actingUser does not match the consumed user-scoped label", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<string>(
      space,
      "cfc-policy-acting-user-miss-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<string>(
      space,
      "cfc-policy-acting-user-miss-target",
      undefined,
      tx,
    );
    source.set("not visible to bob");
    tx.writeOrThrow(cfcLabelsAddress({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
    }), {
      "/": {
        classification: [userAliceAtom],
        integrity: [],
      } satisfies Labels,
    });
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const value = source.withTx(tx).asSchema(sourceSchema).get() ?? "";
    target.withTx(tx).asSchema(actingUserPolicySchema).set(value);

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: bobDid }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "confidentialityMonotonicity",
    });
  });
});
