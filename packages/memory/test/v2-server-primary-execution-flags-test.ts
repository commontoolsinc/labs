import { assertEquals } from "@std/assert";
import * as MemoryV2 from "../v2.ts";

type ServerPrimaryExecutionFlagApi = {
  setServerPrimaryExecutionConfig(enabled?: boolean): void;
  resetServerPrimaryExecutionConfig(): void;
  setServerPrimaryExecutionContextLatticeClaimsConfig(enabled?: boolean): void;
  resetServerPrimaryExecutionContextLatticeClaimsConfig(): void;
  setServerPrimaryExecutionDocSetWatchConfig(enabled?: boolean): void;
  resetServerPrimaryExecutionDocSetWatchConfig(): void;
  getMemoryProtocolFlags(): Record<string, boolean>;
  parseMemoryProtocolFlags(value: unknown): Record<string, boolean> | null;
  wireMemoryProtocolFlags(
    flags: Record<string, boolean>,
  ): Record<string, boolean>;
};

const api = MemoryV2 as unknown as ServerPrimaryExecutionFlagApi;

// `reset*Config()` means "back to the DEFAULT", which since 2026-08-01 is ON
// for the base capability and the context-lattice subcapability (the dial set
// moves as one — see docs/development/EXPERIMENTAL_OPTIONS.md). Where these
// tests need a dial OFF they now say so explicitly: reset is no longer a
// synonym for off, and reading it as one is how a default flip silently stops
// testing the layering.
Deno.test("server-primary execution is an optional protocol capability that defaults ON", () => {
  api.resetServerPrimaryExecutionConfig();
  try {
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionV1,
      true,
    );

    // Explicitly off is the deployment rollback, and it withdraws the whole
    // advertisement.
    api.setServerPrimaryExecutionConfig(false);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionV1,
      false,
    );

    api.setServerPrimaryExecutionConfig(true);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionV1,
      true,
    );
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionClaimRoutingV1,
      true,
    );
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionBuiltinPassivityV1,
      true,
    );

    assertEquals(
      api.parseMemoryProtocolFlags({ serverPrimaryExecutionV1: true })
        ?.serverPrimaryExecutionV1,
      true,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({})?.serverPrimaryExecutionV1,
      false,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({ serverPrimaryExecutionV1: "true" }),
      null,
    );
  } finally {
    api.resetServerPrimaryExecutionConfig();
  }
});

Deno.test("context-lattice-claims-v1 is a separately dialed subcapability that defaults ON with the set", () => {
  api.resetServerPrimaryExecutionConfig();
  api.resetServerPrimaryExecutionContextLatticeClaimsConfig();
  try {
    // Default: advertised, because the dial set moves as one.
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1,
      true,
    );
    // Still SEPARATELY dialed — the partial state is a testing-only
    // affordance, but it must remain reachable and honoured.
    api.setServerPrimaryExecutionContextLatticeClaimsConfig(false);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1,
      false,
    );
    api.setServerPrimaryExecutionContextLatticeClaimsConfig(true);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1,
      true,
    );
    // The subcapability rides on the base capability: with server-primary
    // execution off the advertisement stays off no matter the dial.
    api.setServerPrimaryExecutionConfig(false);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionContextLatticeClaimsV1,
      false,
    );

    // Wire semantics: absent parses to false (an older peer never accepts
    // context-scoped claims), non-boolean rejects, and the flag round-trips.
    assertEquals(
      api.parseMemoryProtocolFlags({})
        ?.serverPrimaryExecutionContextLatticeClaimsV1,
      false,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      })?.serverPrimaryExecutionContextLatticeClaimsV1,
      true,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({
        serverPrimaryExecutionContextLatticeClaimsV1: "true",
      }),
      null,
    );
    api.setServerPrimaryExecutionConfig(true);
    api.setServerPrimaryExecutionContextLatticeClaimsConfig(true);
    assertEquals(
      api.wireMemoryProtocolFlags(api.getMemoryProtocolFlags())
        .serverPrimaryExecutionContextLatticeClaimsV1,
      true,
    );
  } finally {
    api.resetServerPrimaryExecutionConfig();
    api.resetServerPrimaryExecutionContextLatticeClaimsConfig();
  }
});

// The doc-set watch dial is deliberately NOT part of the 2026-08-01 dial set
// (it gates a watch-surface rollout whose gate is the separate W2.9
// measurement), so it still defaults OFF while the base capability defaults on
// — which is exactly the layering this test pins.
Deno.test("doc-set-watch-v1 is a separately dialed subcapability that defaults off", () => {
  api.resetServerPrimaryExecutionConfig();
  api.resetServerPrimaryExecutionDocSetWatchConfig();
  try {
    // Its own dial defaults off: server-primary execution being on never
    // advertises the additive docs watch kind.
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionV1,
      true,
    );
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionDocSetWatchV1,
      false,
    );
    api.setServerPrimaryExecutionDocSetWatchConfig(true);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionDocSetWatchV1,
      true,
    );
    // Rides on the base capability: with server-primary execution off the
    // advertisement stays off no matter the dial.
    api.setServerPrimaryExecutionConfig(false);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionDocSetWatchV1,
      false,
    );

    // Wire semantics: absent parses to false (an older peer never accepts the
    // docs kind), non-boolean rejects, and the flag round-trips.
    assertEquals(
      api.parseMemoryProtocolFlags({})?.serverPrimaryExecutionDocSetWatchV1,
      false,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({
        serverPrimaryExecutionDocSetWatchV1: true,
      })?.serverPrimaryExecutionDocSetWatchV1,
      true,
    );
    assertEquals(
      api.parseMemoryProtocolFlags({
        serverPrimaryExecutionDocSetWatchV1: "true",
      }),
      null,
    );
    api.setServerPrimaryExecutionConfig(true);
    api.setServerPrimaryExecutionDocSetWatchConfig(true);
    assertEquals(
      api.wireMemoryProtocolFlags(api.getMemoryProtocolFlags())
        .serverPrimaryExecutionDocSetWatchV1,
      true,
    );
  } finally {
    api.resetServerPrimaryExecutionConfig();
    api.resetServerPrimaryExecutionDocSetWatchConfig();
  }
});
