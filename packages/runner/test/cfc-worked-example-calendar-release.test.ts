import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import {
  createCfcMultiPartyConsentIntent,
  deriveCfcConsentedByAtom,
  deriveCfcMultiPartyResultLabels,
} from "../src/cfc/multi-party-consent.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example calendar release test",
);
const space = signer.did();
const bobDid = "did:key:bob-calendar-participant";
const carolDid = "did:key:carol-calendar-participant";
const daveDid = "did:key:dave-nonparticipant";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

function createConsent(participant: string) {
  return createCfcMultiPartyConsentIntent({
    participant,
    operation: "FindMeetingTime",
    sharedWith: [space, bobDid, carolDid],
    inputScope: {
      timeRange: { start: 100, end: 200 },
      constraints: {
        onlyFuture: true,
      },
    },
    outputConstraints: {
      maxResults: 3,
      allowEmptyResult: true,
      minimumGranularity: 60,
    },
    evidence: {
      snapshotDigest: `digest:${participant}`,
      timestamp: 50,
    },
    exp: 300,
  });
}

function calendarReleaseSchema(
  consentAtom: ReturnType<typeof deriveCfcConsentedByAtom>,
) {
  return {
    type: "string",
    ifc: {
      declassify: {
        confidentialityPre: [{
          type: "https://commonfabric.org/cfc/atom/MultiPartyResult",
          participants: {
            contains: { var: "$actingUser" },
          },
        }],
        integrityPre: [consentAtom],
        removeMatchedClauses: true,
        postCondition: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/User",
            subject: { var: "$actingUser" },
          }],
        },
        releaseCondition: true,
      },
    },
  } as const satisfies JSONSchema;
}

describe("CFC worked example: calendar participant release", () => {
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

  it("releases a multi-party result to a participant via $actingUser membership", async () => {
    const aliceConsent = createConsent(space);
    const bobConsent = createConsent(bobDid);
    const carolConsent = createConsent(carolDid);
    const consentAtom = deriveCfcConsentedByAtom([
      aliceConsent,
      bobConsent,
      carolConsent,
    ]);

    let tx = runtime.edit();
    const result = runtime.getCell<string>(
      space,
      "calendar-release-result",
      undefined,
      tx,
    );
    const aliceView = runtime.getCell<string>(
      space,
      "calendar-release-alice-view",
      undefined,
      tx,
    );
    result.set("2026-03-20T17:00:00Z");
    tx.writeOrThrow(
      cfcLabelsAddress({
        space,
        id: result.getAsNormalizedFullLink().id,
        type: "application/json",
      }),
      {
        "/": deriveCfcMultiPartyResultLabels({
          consents: [bobConsent, carolConsent, aliceConsent],
          codeHash: "sha256:findMeetingTimes-v1",
        }),
      } satisfies Record<string, Labels>,
    );
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const value = result.withTx(tx).get() ?? "";
    aliceView.withTx(tx).asSchema(calendarReleaseSchema(consentAtom)).set(
      value,
    );

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(
      aliceView.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual([[userAliceAtom]]);
  });

  it("fails closed for a non-participant acting user", async () => {
    const aliceConsent = createConsent(space);
    const bobConsent = createConsent(bobDid);
    const carolConsent = createConsent(carolDid);
    const consentAtom = deriveCfcConsentedByAtom([
      aliceConsent,
      bobConsent,
      carolConsent,
    ]);

    let tx = runtime.edit();
    const result = runtime.getCell<string>(
      space,
      "calendar-release-result-miss",
      undefined,
      tx,
    );
    const daveView = runtime.getCell<string>(
      space,
      "calendar-release-dave-view",
      undefined,
      tx,
    );
    result.set("2026-03-20T17:00:00Z");
    tx.writeOrThrow(
      cfcLabelsAddress({
        space,
        id: result.getAsNormalizedFullLink().id,
        type: "application/json",
      }),
      {
        "/": deriveCfcMultiPartyResultLabels({
          consents: [aliceConsent, bobConsent, carolConsent],
          codeHash: "sha256:findMeetingTimes-v1",
        }),
      } satisfies Record<string, Labels>,
    );
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const value = result.withTx(tx).get() ?? "";
    daveView.withTx(tx).asSchema(calendarReleaseSchema(consentAtom)).set(value);

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: daveDid }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "confidentialityMonotonicity",
    });
  });
});
