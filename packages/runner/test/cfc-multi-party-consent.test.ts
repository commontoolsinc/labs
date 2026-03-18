import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createCfcMultiPartyConsentIntent,
  deriveCfcConsentedByAtom,
  validateCfcMultiPartyConsent,
} from "../src/cfc/multi-party-consent.ts";

describe("CFC multi-party consent", () => {
  function createConsent(overrides: {
    readonly participant?: string;
    readonly sharedWith?: readonly string[];
    readonly start?: number;
    readonly end?: number;
    readonly maxResults?: number;
    readonly allowEmptyResult?: boolean;
    readonly minimumGranularity?: number;
    readonly exp?: number;
    readonly hoursStart?: number;
    readonly hoursEnd?: number;
  } = {}) {
    const participant = overrides.participant ?? "did:key:alice";
    return createCfcMultiPartyConsentIntent({
      participant,
      operation: "FindMeetingTime",
      sharedWith: overrides.sharedWith ?? [
        "did:key:alice",
        "did:key:bob",
        "did:key:carol",
      ],
      inputScope: {
        timeRange: {
          start: overrides.start ?? 100,
          end: overrides.end ?? 200,
        },
        constraints: {
          onlyFuture: true,
          hoursRange: {
            start: overrides.hoursStart ?? 9,
            end: overrides.hoursEnd ?? 17,
          },
        },
      },
      outputConstraints: {
        maxResults: overrides.maxResults ?? 3,
        allowEmptyResult: overrides.allowEmptyResult ?? true,
        minimumGranularity: overrides.minimumGranularity ?? 60,
      },
      evidence: {
        snapshotDigest: `digest:${participant}`,
        timestamp: 50,
      },
      exp: overrides.exp ?? 300,
    });
  }

  it("derives a stable id for identical consent intents", () => {
    const a = createConsent();
    const b = createConsent();
    const c = createConsent({ maxResults: 2 });

    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("validates compatible consents and derives a conservative effective scope", () => {
    const alice = createConsent({
      participant: "did:key:alice",
      start: 100,
      end: 220,
      maxResults: 4,
      hoursStart: 9,
      hoursEnd: 17,
    });
    const bob = createConsent({
      participant: "did:key:bob",
      start: 120,
      end: 240,
      maxResults: 3,
      hoursStart: 10,
      hoursEnd: 18,
    });
    const carol = createConsent({
      participant: "did:key:carol",
      start: 110,
      end: 210,
      maxResults: 2,
      hoursStart: 8,
      hoursEnd: 16,
    });

    expect(
      validateCfcMultiPartyConsent(
        [alice, bob, carol],
        { now: () => 90 },
      ),
    ).toEqual({
      valid: true,
      effectiveScope: {
        participants: [
          "did:key:alice",
          "did:key:bob",
          "did:key:carol",
        ],
        timeRange: {
          start: 120,
          end: 210,
        },
        constraints: {
          onlyFuture: true,
          hoursRange: {
            start: 10,
            end: 16,
          },
        },
        maxResults: 2,
        allowEmptyResult: true,
        minimumGranularity: 60,
      },
    });
  });

  it("rejects participant-set mismatch", () => {
    const alice = createConsent({ participant: "did:key:alice" });
    const bob = createConsent({
      participant: "did:key:bob",
      sharedWith: ["did:key:alice", "did:key:bob"],
    });

    expect(
      validateCfcMultiPartyConsent([alice, bob], { now: () => 90 }),
    ).toEqual({
      valid: false,
      error: "participant_mismatch",
    });
  });

  it("rejects expired consents", () => {
    const alice = createConsent({ exp: 80 });
    const bob = createConsent({ participant: "did:key:bob" });

    expect(
      validateCfcMultiPartyConsent([alice, bob], { now: () => 90 }),
    ).toEqual({
      valid: false,
      error: "consent_expired",
    });
  });

  it("rejects disjoint time ranges", () => {
    const alice = createConsent({
      start: 100,
      end: 120,
      sharedWith: ["did:key:alice", "did:key:bob"],
    });
    const bob = createConsent({
      participant: "did:key:bob",
      start: 130,
      end: 150,
      sharedWith: ["did:key:alice", "did:key:bob"],
    });

    expect(
      validateCfcMultiPartyConsent([alice, bob], { now: () => 90 }),
    ).toEqual({
      valid: false,
      error: "scope_disjoint",
    });
  });

  it("derives a deterministic ConsentedBy atom from compatible consents", () => {
    const alice = createConsent({ participant: "did:key:alice" });
    const bob = createConsent({ participant: "did:key:bob" });
    const carol = createConsent({ participant: "did:key:carol" });

    expect(
      deriveCfcConsentedByAtom([carol, alice, bob]),
    ).toEqual({
      type: "https://commonfabric.org/cfc/atom/ConsentedBy",
      consents: [alice.id, bob.id, carol.id].sort(),
    });
  });
});
