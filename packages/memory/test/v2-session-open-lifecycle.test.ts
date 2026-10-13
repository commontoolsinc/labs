import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("v2-session-open-lifecycle", () => {
  for (const mode of ["off", "enforce"] as const) {
    for (const outcome of ["closed", "failed", "replaced"] as const) {
      const description = outcome === "replaced"
        ? "keeps a newer owner when an older opening connection closes during catch-up"
        : outcome === "failed"
        ? "detaches a session whose opening connection closes during failed catch-up"
        : "detaches a session whose opening connection closes during catch-up";
      it(`${description} (${mode})`, async () => {
        // Ownership is registered before catch-up reads its engine. Closing
        // that connection starts its session's grace period even while the
        // read is pending, and cannot detach a replacement owner.
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL(`memory://open-catchup-${mode}-${outcome}`),
          acl: { mode, serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
        });
        const messages: ServerMessage[] = [];
        const first = server.connect((message) => messages.push(message));
        const second = server.connect((message) => messages.push(message));
        const third = server.connect((message) => messages.push(message));
        const space = "did:key:z6Mk-open-catchup";
        const sessionId = "session:open-catchup";
        let opening: Promise<void> | undefined;

        /** Returns a connection's authorization metadata after its hello. */
        const hello = async (
          connection: typeof first,
        ): Promise<SessionOpenAuthMetadata> => {
          await connection.receive(encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: getMemoryProtocolFlags(),
          }));
          const reply = messages.pop();
          if (reply?.type !== "hello.ok" || reply.sessionOpen === undefined) {
            throw new Error("Expected hello authorization metadata");
          }
          return reply.sessionOpen;
        };

        /** Sends an open authenticated by the connection's hello challenge. */
        const sendOpen = (
          connection: typeof first,
          auth: SessionOpenAuthMetadata,
          requestId: string,
          session: SessionDescriptor,
        ) =>
          connection.receive(encodeMemoryBoundary({
            type: "session.open",
            requestId,
            space,
            session,
            invocation: { aud: auth.audience, challenge: auth.challenge.value },
            authorization: {},
          }));

        /** Returns the server's current retained session for this space. */
        const retainedSession = () =>
          server.accessForTestingOnly.sessionsForSpace(space)
            .find((session) => session.id === sessionId);

        try {
          await sendOpen(first, await hello(first), "open-first", {
            sessionId,
            resumeKey: "key",
            resumeAttempt: 1,
          });
          const original = retainedSession();
          expect(original).toBeDefined();
          if (original === undefined) {
            throw new Error("Expected mounted session");
          }
          first.close();
          const secondAuth = await hello(second);
          let heldCatchup = false;
          server.accessForTestingOnly.engineOpener = async (target, open) => {
            // Admission sees the detached owner. Only the catch-up read
            // sees this new owner, so the gate holds the real read there.
            if (
              !heldCatchup &&
              server.isSessionAttached(space, sessionId, second.id)
            ) {
              heldCatchup = true;
              reached.resolve();
              await release.promise;
              if (outcome === "failed") throw new Error("catch-up read failed");
            }
            return await open(target);
          };
          opening = sendOpen(second, secondAuth, "open-second", {
            sessionId,
            sessionToken: original.sessionToken,
            resumeKey: "key",
            resumeAttempt: 2,
          });
          await reached.promise;
          if (outcome === "replaced") {
            const held = retainedSession();
            expect(held).toBeDefined();
            if (held === undefined) {
              throw new Error("Expected resuming session");
            }
            await sendOpen(third, await hello(third), "open-third", {
              sessionId,
              sessionToken: held.sessionToken,
              resumeKey: "replacement-key",
              resumeAttempt: 1,
            });
          }
          second.close();
          if (outcome !== "replaced") {
            expect(retainedSession()).toMatchObject({
              ownerConnectionId: null,
              expiresAt: expect.any(Number),
            });
          }
          release.resolve();
          await opening;
          expect(server.isSessionAttached(space, sessionId, second.id)).toBe(
            false,
          );
          if (outcome === "replaced") {
            expect(server.isSessionAttached(space, sessionId, third.id)).toBe(
              true,
            );
            expect(retainedSession()).toMatchObject({
              ownerConnectionId: third.id,
              expiresAt: null,
            });
          }
          const response = messages.find((message) =>
            message.type === "response" && message.requestId === "open-second"
          );
          expect(response).toMatchObject({
            error: outcome === "failed"
              ? { name: "ProtocolError", message: "catch-up read failed" }
              : {
                name: "SessionError",
                message: "The connection closed during catch-up",
              },
          });
        } finally {
          release.resolve();
          await opening;
          server.accessForTestingOnly.engineOpener = undefined;
          first.close();
          second.close();
          third.close();
          await server.close();
        }
      });
    }
  }
});
