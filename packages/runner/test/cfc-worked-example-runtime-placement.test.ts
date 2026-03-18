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
  "cfc worked example runtime placement test",
);
const space = signer.did();
const bobDid = "did:key:bob-runtime-placement";
const carolDid = "did:key:carol-runtime-placement";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const rawAudioCaveatAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/raw-audio",
  source: "mic-buffer-epoch-8842",
} as const;

const sharedCcExecutionIntegrity = [
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
    profile: "calendar-intersection-v1",
  },
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeTEE",
    tee: "approved-tee-class",
  },
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeProvider",
    provider: "approved-provider",
  },
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeImage",
    imageHash: "sha256:approved-image",
  },
] as const;

const audioExecutionIntegrity = [
  {
    type: "https://commonfabric.org/cfc/atom/AudioTrigger",
    kind: "song-detected",
  },
  {
    type: "https://commonfabric.org/cfc/atom/AudioFilterApplied",
    profile: "speech-redaction-v3",
  },
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
    profile: "audio-postproc-v1",
  },
  {
    type: "https://commonfabric.org/cfc/atom/RuntimeImage",
    imageHash: "sha256:approved-audio-image",
  },
] as const;

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

function calendarSharedCcReleaseSchema(
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
        integrityPre: [
          consentAtom,
          ...sharedCcExecutionIntegrity,
        ],
        removeMatchedClauses: true,
        postCondition: {
          confidentiality: [userAliceAtom],
        },
        releaseCondition: true,
      },
    },
  } as const satisfies JSONSchema;
}

const filteredAudioSchema = {
  type: "string",
  ifc: {
    declassify: {
      confidentialityPre: [rawAudioCaveatAtom],
      integrityPre: [...audioExecutionIntegrity],
      removeMatchedClauses: true,
      postCondition: {
        confidentiality: [userAliceAtom],
      },
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC worked example: runtime placement variants", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let executionIntegrity: readonly unknown[] | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime(Object.assign({
      storageManager,
      apiUrl: new URL(import.meta.url),
    }, {
      cfcExecutionIntegrity: () => executionIntegrity,
    }));
    runtime.scheduler.disablePullMode();
    executionIntegrity = undefined;
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

  it("releases a calendar result only inside the approved shared CC profile", async () => {
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
      "runtime-placement-calendar-result",
      undefined,
      tx,
    );
    const participantView = runtime.getCell<string>(
      space,
      "runtime-placement-calendar-view",
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
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const value = result.withTx(tx).get() ?? "";
    participantView.withTx(tx).asSchema(
      calendarSharedCcReleaseSchema(consentAtom),
    ).set(value);

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
    });
    await tx.abort();

    executionIntegrity = sharedCcExecutionIntegrity;

    tx = runtime.edit();
    participantView.withTx(tx).asSchema(
      calendarSharedCcReleaseSchema(consentAtom),
    ).set(result.withTx(tx).get() ?? "");

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(
      participantView.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual([[userAliceAtom]]);
  });

  it("releases filtered audio only when trigger, filter, and runtime evidence are present", async () => {
    let tx = runtime.edit();
    const rawAudio = runtime.getCell<string>(
      space,
      "runtime-placement-raw-audio",
      undefined,
      tx,
    );
    const filteredAudio = runtime.getCell<string>(
      space,
      "runtime-placement-filtered-audio",
      undefined,
      tx,
    );
    rawAudio.set("filtered-song-features");
    tx.writeOrThrow(
      cfcLabelsAddress({
        space,
        id: rawAudio.getAsNormalizedFullLink().id,
        type: "application/json",
      }),
      {
        "/": {
          classification: [[userAliceAtom], [rawAudioCaveatAtom]],
        },
      } satisfies Record<string, Labels>,
    );
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    filteredAudio.withTx(tx).asSchema(filteredAudioSchema).set(
      rawAudio.withTx(tx).get() ?? "",
    );
    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
    });
    await tx.abort();

    executionIntegrity = audioExecutionIntegrity;

    tx = runtime.edit();
    filteredAudio.withTx(tx).asSchema(filteredAudioSchema).set(
      rawAudio.withTx(tx).get() ?? "",
    );
    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(
      filteredAudio.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual([[userAliceAtom]]);
  });
});
