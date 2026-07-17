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

Deno.test("server-primary execution is an optional protocol capability that defaults off", () => {
  api.resetServerPrimaryExecutionConfig();
  try {
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

Deno.test("context-lattice-claims-v1 is a separately dialed subcapability that defaults off", () => {
  api.resetServerPrimaryExecutionConfig();
  api.resetServerPrimaryExecutionContextLatticeClaimsConfig();
  try {
    // Its own dial defaults off: enabling server-primary execution alone
    // never advertises context-scoped claim delivery.
    api.setServerPrimaryExecutionConfig(true);
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
    api.resetServerPrimaryExecutionConfig();
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

Deno.test("doc-set-watch-v1 is a separately dialed subcapability that defaults off", () => {
  api.resetServerPrimaryExecutionConfig();
  api.resetServerPrimaryExecutionDocSetWatchConfig();
  try {
    // Its own dial defaults off: enabling server-primary execution alone never
    // advertises the additive docs watch kind.
    api.setServerPrimaryExecutionConfig(true);
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
    api.resetServerPrimaryExecutionConfig();
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
