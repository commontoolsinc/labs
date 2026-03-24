import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import {
  createCfcMultiPartyConsentIntent,
  deriveCfcConsentedByAtom,
  deriveCfcMultiPartyResultLabels,
} from "../src/cfc/multi-party-consent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcIntegrityLabel } from "../src/cfc/label-algebra.ts";
import type { Labels } from "../src/storage/interface.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

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

const alicePhoneDeviceAtom = {
  type: "https://commonfabric.org/cfc/atom/DeviceIdentity",
  device: "did:key:alice-phone-1",
} as const;

const aliceManagedHighTierAtom = {
  type: "https://commonfabric.org/cfc/atom/DeviceTier",
  owner: space,
  tier: "managed-high",
} as const;

const strongClientAppAttestedAtom = {
  type: "https://commonfabric.org/cfc/atom/ClientAppAttested",
  platform: "ios",
  appId: "org.example.calendar",
  verdict: "strong",
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

const stringSchema = {
  type: "string",
} as const satisfies JSONSchema;

const releaseInputSchema = {
  type: "object",
  properties: {
    source: stringSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

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

const exactDeviceReleaseSchema = {
  type: "string",
  ifc: {
    declassify: {
      confidentialityPre: [alicePhoneDeviceAtom],
      integrityPre: [
        alicePhoneDeviceAtom,
        strongClientAppAttestedAtom,
      ],
      removeMatchedClauses: true,
      postCondition: {
        confidentiality: [userAliceAtom],
      },
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const ownerTierReleaseSchema = {
  type: "string",
  ifc: {
    declassify: {
      confidentialityPre: [{
        type: "https://commonfabric.org/cfc/atom/DeviceTier",
        owner: { var: "$actingUser" },
        tier: "managed-high",
      }],
      integrityPre: [
        {
          type: "https://commonfabric.org/cfc/atom/DeviceTier",
          owner: { var: "$actingUser" },
          tier: "managed-high",
        },
        strongClientAppAttestedAtom,
      ],
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

describe("CFC worked example: runtime placement variants", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;
  let executionIntegrity: CfcIntegrityLabel | undefined;

  beforeEach(() => {
    executionIntegrity = undefined;
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
      runtimeOptions: {
        cfcExecutionIntegrity: () => executionIntegrity,
      },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function createReleasePattern(outputSchema: JSONSchema) {
    return harness.pattern<{ source: string }>(
      ({ source }) =>
        harness.lift(
          stringSchema,
          outputSchema,
          (value) => value,
        )(source),
      releaseInputSchema,
      outputSchema,
    );
  }

  async function runReleasePattern(
    options: {
      sourceId: string;
      outputId: string;
      outputSchema: JSONSchema;
    },
  ) {
    const source = harness.getCell<string>(options.sourceId, stringSchema);
    return await harness.runPattern({
      id: options.outputId,
      pattern: createReleasePattern(options.outputSchema),
      inputs: { source },
      outputSchema: options.outputSchema,
      prepare: "cfc",
    });
  }

  async function expectBlockedOutputMissing(
    outputId: string,
    outputSchema: JSONSchema,
  ) {
    await harness.restart();
    const persistedOutput = harness.getCell<string>(outputId, outputSchema);
    expect(await persistedOutput.pull()).toBeUndefined();
  }

  async function expectReleasedAsAlice(
    outputId: string,
    outputSchema: JSONSchema,
    expectedValue: string,
  ) {
    await harness.restart();
    const persistedOutput = harness.getCell<string>(outputId, outputSchema);
    expect(await persistedOutput.pull()).toEqual(expectedValue);
    expect(
      (await harness.readEffectiveLabel(persistedOutput, outputSchema))
        ?.classification,
    ).toEqual([[userAliceAtom]]);
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
    await harness.seedLabeledValue({
      id: "runtime-placement-calendar-result",
      schema: stringSchema,
      value: "2026-03-20T17:00:00Z",
      labels: deriveCfcMultiPartyResultLabels({
        consents: [aliceConsent, bobConsent, carolConsent],
        codeHash: "sha256:findMeetingTimes-v1",
      }),
    });

    await harness.restart();

    const blockedRun = await runReleasePattern({
      sourceId: "runtime-placement-calendar-result",
      outputId: "runtime-placement-calendar-view-blocked",
      outputSchema: calendarSharedCcReleaseSchema(consentAtom),
    });
    expect(await blockedRun.result.pull()).toBeUndefined();
    await expectBlockedOutputMissing(
      "runtime-placement-calendar-view-blocked",
      calendarSharedCcReleaseSchema(consentAtom),
    );

    executionIntegrity = [...sharedCcExecutionIntegrity];

    await runReleasePattern({
      sourceId: "runtime-placement-calendar-result",
      outputId: "runtime-placement-calendar-view",
      outputSchema: calendarSharedCcReleaseSchema(consentAtom),
    });

    await expectReleasedAsAlice(
      "runtime-placement-calendar-view",
      calendarSharedCcReleaseSchema(consentAtom),
      "2026-03-20T17:00:00Z",
    );
  });

  it("releases filtered audio only when trigger, filter, and runtime evidence are present", async () => {
    await harness.seedLabeledValue({
      id: "runtime-placement-raw-audio",
      schema: stringSchema,
      value: "filtered-song-features",
      labels: {
        classification: [[userAliceAtom], [rawAudioCaveatAtom]],
      } satisfies Labels,
    });

    await harness.restart();

    const blockedRun = await runReleasePattern({
      sourceId: "runtime-placement-raw-audio",
      outputId: "runtime-placement-filtered-audio-blocked",
      outputSchema: filteredAudioSchema,
    });
    expect(await blockedRun.result.pull()).toBeUndefined();
    await expectBlockedOutputMissing(
      "runtime-placement-filtered-audio-blocked",
      filteredAudioSchema,
    );

    executionIntegrity = [...audioExecutionIntegrity];

    await runReleasePattern({
      sourceId: "runtime-placement-raw-audio",
      outputId: "runtime-placement-filtered-audio",
      outputSchema: filteredAudioSchema,
    });

    await expectReleasedAsAlice(
      "runtime-placement-filtered-audio",
      filteredAudioSchema,
      "filtered-song-features",
    );
  });

  it("allows exact-device release only on the enrolled device identity", async () => {
    await harness.seedLabeledValue({
      id: "runtime-placement-local-availability",
      schema: stringSchema,
      value: "09:00-10:00",
      labels: {
        classification: [[userAliceAtom], [alicePhoneDeviceAtom]],
      } satisfies Labels,
    });

    await harness.restart();

    executionIntegrity = [
      {
        type: "https://commonfabric.org/cfc/atom/DeviceIdentity",
        device: "did:key:alice-tablet-1",
      },
      strongClientAppAttestedAtom,
    ];

    const blockedRun = await runReleasePattern({
      sourceId: "runtime-placement-local-availability",
      outputId: "runtime-placement-device-release-blocked",
      outputSchema: exactDeviceReleaseSchema,
    });
    expect(await blockedRun.result.pull()).toBeUndefined();
    await expectBlockedOutputMissing(
      "runtime-placement-device-release-blocked",
      exactDeviceReleaseSchema,
    );

    executionIntegrity = [alicePhoneDeviceAtom, strongClientAppAttestedAtom];

    await runReleasePattern({
      sourceId: "runtime-placement-local-availability",
      outputId: "runtime-placement-device-release",
      outputSchema: exactDeviceReleaseSchema,
    });

    await expectReleasedAsAlice(
      "runtime-placement-device-release",
      exactDeviceReleaseSchema,
      "09:00-10:00",
    );
  });

  it("allows owner-tier release on same-owner managed devices but rejects others", async () => {
    await harness.seedLabeledValue({
      id: "runtime-placement-tier-source",
      schema: stringSchema,
      value: "10:00-11:00",
      labels: {
        classification: [[userAliceAtom], [aliceManagedHighTierAtom]],
      } satisfies Labels,
    });

    await harness.restart();

    executionIntegrity = [
      {
        type: "https://commonfabric.org/cfc/atom/DeviceTier",
        owner: bobDid,
        tier: "managed-high",
      },
      strongClientAppAttestedAtom,
    ];

    const blockedRun = await runReleasePattern({
      sourceId: "runtime-placement-tier-source",
      outputId: "runtime-placement-tier-release-blocked",
      outputSchema: ownerTierReleaseSchema,
    });
    expect(await blockedRun.result.pull()).toBeUndefined();
    await expectBlockedOutputMissing(
      "runtime-placement-tier-release-blocked",
      ownerTierReleaseSchema,
    );

    executionIntegrity = [
      aliceManagedHighTierAtom,
      strongClientAppAttestedAtom,
    ];

    await runReleasePattern({
      sourceId: "runtime-placement-tier-source",
      outputId: "runtime-placement-tier-release",
      outputSchema: ownerTierReleaseSchema,
    });

    await expectReleasedAsAlice(
      "runtime-placement-tier-release",
      ownerTierReleaseSchema,
      "10:00-11:00",
    );
  });
});
