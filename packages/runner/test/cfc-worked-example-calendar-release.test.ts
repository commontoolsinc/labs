import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import {
  createCfcMultiPartyConsentIntent,
  deriveCfcConsentedByAtom,
  deriveCfcMultiPartyResultLabels,
} from "../src/cfc/multi-party-consent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example calendar release test",
);
const space = signer.did();
const bobDid = "did:key:bob-calendar-participant";
const carolDid = "did:key:carol-calendar-participant";
const daveSigner = await Identity.fromPassphrase(
  "cfc worked example calendar release dave",
);

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const stringSchema = {
  type: "string",
} as const satisfies JSONSchema;

const calendarReleaseInputSchema = {
  type: "object",
  properties: {
    result: stringSchema,
  },
  required: ["result"],
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
  let harness: ReturnType<typeof createCfcPatternTestHarness>;

  beforeEach(() => {
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function createCalendarReleasePattern(
    testHarness: ReturnType<typeof createCfcPatternTestHarness>,
    consentAtom: ReturnType<typeof deriveCfcConsentedByAtom>,
  ) {
    return testHarness.pattern<{ result: string }>(
      ({ result }) =>
        testHarness.lift(
          stringSchema,
          calendarReleaseSchema(consentAtom),
          (value) => value,
        )(result),
      calendarReleaseInputSchema,
      calendarReleaseSchema(consentAtom),
    );
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

    await harness.seedLabeledValue({
      id: "calendar-release-result",
      schema: stringSchema,
      value: "2026-03-20T17:00:00Z",
      labels: deriveCfcMultiPartyResultLabels({
        consents: [bobConsent, carolConsent, aliceConsent],
        codeHash: "sha256:findMeetingTimes-v1",
      }),
    });

    await harness.restart();

    const persistedResult = harness.getCell<string>(
      "calendar-release-result",
      stringSchema,
    );
    const run = await harness.runPattern({
      id: "calendar-release-alice-view",
      pattern: createCalendarReleasePattern(harness, consentAtom),
      inputs: { result: persistedResult },
      outputSchema: calendarReleaseSchema(consentAtom),
      initialOutput: "",
      prepare: "cfc",
    });

    expect(await run.result.pull()).toEqual("2026-03-20T17:00:00Z");

    await harness.restart();

    const persistedView = harness.getCell<string>(
      "calendar-release-alice-view",
      calendarReleaseSchema(consentAtom),
    );
    expect(
      (await harness.readEffectiveLabel(
        persistedView,
        calendarReleaseSchema(consentAtom),
      ))?.classification,
    ).toEqual([[userAliceAtom]]);
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
    const daveHarness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
      actingPrincipalOverride: daveSigner.did(),
    });

    try {
      await daveHarness.seedLabeledValue({
        id: "calendar-release-result-miss",
        schema: stringSchema,
        value: "2026-03-20T17:00:00Z",
        labels: deriveCfcMultiPartyResultLabels({
          consents: [aliceConsent, bobConsent, carolConsent],
          codeHash: "sha256:findMeetingTimes-v1",
        }),
      });

      await daveHarness.restart();

      const persistedResult = daveHarness.getCell<string>(
        "calendar-release-result-miss",
        stringSchema,
      );

      const run = await daveHarness.runPattern({
        id: "calendar-release-dave-view",
        pattern: createCalendarReleasePattern(daveHarness, consentAtom),
        inputs: { result: persistedResult },
        outputSchema: calendarReleaseSchema(consentAtom),
        prepare: "cfc",
      });
      expect(await run.result.pull()).toBeUndefined();

      await daveHarness.restart();
      const persistedDaveView = daveHarness.getCell<string>(
        "calendar-release-dave-view",
        calendarReleaseSchema(consentAtom),
      );
      expect(await persistedDaveView.pull()).toBeUndefined();
    } finally {
      await daveHarness.dispose();
    }
  });
});
