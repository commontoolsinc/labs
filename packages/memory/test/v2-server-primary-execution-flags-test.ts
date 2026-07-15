import { assertEquals } from "@std/assert";
import * as MemoryV2 from "../v2.ts";

type ServerPrimaryExecutionFlagApi = {
  setServerPrimaryExecutionConfig(enabled?: boolean): void;
  resetServerPrimaryExecutionConfig(): void;
  getMemoryProtocolFlags(): Record<string, boolean>;
  parseMemoryProtocolFlags(value: unknown): Record<string, boolean> | null;
};

const api = MemoryV2 as unknown as ServerPrimaryExecutionFlagApi;

Deno.test("server-primary execution defaults on with an explicit rollback override", () => {
  api.resetServerPrimaryExecutionConfig();
  try {
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

    api.setServerPrimaryExecutionConfig(false);
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionV1,
      false,
    );
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionClaimRoutingV1,
      false,
    );
    assertEquals(
      api.getMemoryProtocolFlags().serverPrimaryExecutionBuiltinPassivityV1,
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
