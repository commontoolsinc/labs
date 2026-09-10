import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
} from "../v2.ts";
import { testSessionOpenAuth } from "./v2-auth-test-helpers.ts";

Deno.test("memory v2 server rejects malformed input without poisoning the connection", async () => {
  const messages: ServerMessage[] = [];
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-server-ingress-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive("{");
    assertEquals(messages.shift(), {
      type: "response",
      requestId: "invalid",
      error: {
        name: "InvalidMessageError",
        message: "Unable to parse memory message",
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    assertEquals(messages.shift()?.type, "hello.ok");
    assertEquals(messages, []);
  } finally {
    connection.close();
    await server.close();
  }
});
