import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc policy atom pattern test");
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const authorizedRequestAtom = {
  type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
  policy: "fetchData-sink-gate",
  endpoint: "GET /gmail/v1/users/me/messages",
  requestDigest: "cfc:fetch-request:policy-atom-test",
  codeHash: "Builtin(fetchData)",
  user: space,
} as const;

const secretSourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const userScopedSourceSchema = {
  type: "number",
  ifc: { classification: [userAliceAtom] },
} as const satisfies JSONSchema;

const integrityPatternDeclassifySchema = {
  type: "number",
  ifc: {
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: [{
        type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        endpoint: "GET /gmail/v1/users/me/messages",
      }],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const missingIntegrityPatternDeclassifySchema = {
  type: "number",
  ifc: {
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: [{
        type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        endpoint: "GET /gmail/v1/users/me/profile",
      }],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const confidentialityPatternDeclassifySchema = {
  type: "number",
  ifc: {
    declassify: {
      confidentialityPre: [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: space,
      }],
      integrityPre: ["proof-token"],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC policy atom-pattern preconditions", () => {
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
    }, {
      "/": labels,
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("allows structured integrityPre object patterns in policy rewrites", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-atom-integrity-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-atom-integrity-target",
      undefined,
      tx,
    );
    source.set(5);
    target.set(0);
    await tx.commit();

    await seedValueWithLabels(source.getAsNormalizedFullLink().id, 5, {
      classification: ["secret"],
      integrity: [authorizedRequestAtom],
    });

    tx = runtime.edit();
    const value = Number(
      source.withTx(tx).asSchema(secretSourceSchema).get() ?? 0,
    );
    target.withTx(tx).asSchema(integrityPatternDeclassifySchema).set(value + 1);

    await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
  });

  it("rejects policy rewrites when structured integrityPre object patterns do not match", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-atom-integrity-miss-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-atom-integrity-miss-target",
      undefined,
      tx,
    );
    source.set(6);
    target.set(0);
    await tx.commit();

    await seedValueWithLabels(source.getAsNormalizedFullLink().id, 6, {
      classification: ["secret"],
      integrity: [authorizedRequestAtom],
    });

    tx = runtime.edit();
    const value = Number(
      source.withTx(tx).asSchema(secretSourceSchema).get() ?? 0,
    );
    target.withTx(tx).asSchema(missingIntegrityPatternDeclassifySchema).set(
      value + 1,
    );

    await expect(prepareCfcCommitIfNeeded(tx)).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "confidentialityMonotonicity",
    });
  });

  it("allows structured confidentialityPre object patterns in policy rewrites", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-atom-conf-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-atom-conf-target",
      undefined,
      tx,
    );
    source.set(9);
    target.set(0);
    await tx.commit();

    await seedValueWithLabels(source.getAsNormalizedFullLink().id, 9, {
      classification: [userAliceAtom],
      integrity: ["proof-token"],
    });

    tx = runtime.edit();
    const value = Number(
      source.withTx(tx).asSchema(userScopedSourceSchema).get() ?? 0,
    );
    target.withTx(tx).asSchema(confidentialityPatternDeclassifySchema).set(
      value + 1,
    );

    await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
  });
});
