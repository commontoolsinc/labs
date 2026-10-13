import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** How many times the memory client has logged a terminated session. */
const terminatedSessions = (): number =>
  getLoggerCountsBreakdown()["memory.v2.client"]?.["session-terminated"]
    ?.error ?? 0;

describe("memory session loss logging", () => {
  it("records a session taken over by another connection, and a resume refused for a stale token", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-loss-logging"),
    });
    const space = "did:key:z6Mk-session-loss-logging";
    const holder = await connect({ transport: loopback(server) });
    const taker = await connect({ transport: loopback(server) });
    const late = await connect({ transport: loopback(server) });
    const warnings: string[] = [];
    const warn = stub(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const held = await holder.mount(space, {}, testSessionOpenAuthFactory);
      const stale = {
        sessionId: held.sessionId,
        sessionToken: held.sessionToken,
      };
      const before = terminatedSessions();

      const taken = await taker.mount(space, stale, testSessionOpenAuthFactory);
      expect(held.closeError?.name).toBe("SessionRevokedError");
      expect(terminatedSessions()).toBe(before + 1);
      expect(
        warnings.some((line) =>
          line.includes(`session ${held.sessionId} on ${space} moved from`)
        ),
      ).toBe(true);

      await expect(late.mount(space, stale, testSessionOpenAuthFactory))
        .rejects.toThrow("resume token is no longer valid");
      expect(
        warnings.some((line) =>
          line.includes(`refused to resume session ${held.sessionId}`)
        ),
      ).toBe(true);
      expect(taken.closeError).toBeUndefined();
    } finally {
      warn.restore();
      await holder.close();
      await taker.close();
      await late.close();
      await server.close();
    }
  });
});
