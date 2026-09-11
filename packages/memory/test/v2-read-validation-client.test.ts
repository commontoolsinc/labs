/** Verifies required dependency negotiation at initial issue and reconnect. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  parseMemoryProtocolFlags,
  toDocumentPath,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** Overrides only the advertised capability and can drop one unissued commit. */
function validationTransport(
  server: Server,
  capable: boolean,
  dropFirst: boolean,
): {
  transport: Transport;
  sent: () => number;
  hellos: () => number;
  disconnect: () => void;
} {
  let receiver: (payload: string) => void = () => {};
  let closeReceiver: (error?: Error) => void = () => {};
  let connection: ReturnType<Server["connect"]> | undefined;
  let connectionCount = 0;
  let commits = 0;
  let hellos = 0;
  const transport: Transport = {
    async send(payload) {
      if (connection === undefined) {
        connectionCount++;
        connection = server.connect((message) => {
          receiver(encodeMemoryBoundary(
            message.type === "hello.ok"
              ? {
                ...message,
                flags: {
                  ...message.flags,
                  readValidation: capable && connectionCount === 1,
                },
              }
              : message,
          ));
        });
      }
      const message = decodeMemoryBoundary(payload) as { type: string };
      if (message.type === "hello") hellos++;
      if (message.type === "transact") {
        commits++;
        if (dropFirst && commits === 1) {
          connection.close();
          connection = undefined;
          closeReceiver(
            new Error("connection replaced before commit delivery"),
          );
          return;
        }
      }
      await connection.receive(payload);
    },
    close() {
      connection?.close();
      connection = undefined;
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
  return {
    transport,
    sent: () => commits,
    hellos: () => hellos,
    disconnect: () => {
      connection?.close();
      connection = undefined;
      closeReceiver(
        new Error("connection replaced before request continuation"),
      );
    },
  };
}

/** Returns one dependency on an absent document and its creation operation. */
function writeCommit(validation?: "required" | "elidable"): ClientCommit {
  return {
    localSeq: 1,
    reads: {
      confirmed: [{
        id: "of:read-validation",
        path: toDocumentPath([]),
        seq: 0,
        validation,
      }],
      pending: [],
    },
    operations: [{
      op: "set",
      id: "of:read-validation",
      value: { value: "created" },
    }],
  };
}

describe("v2-read-validation-client", () => {
  it("requires positive capability advertisement and preserves it on the wire", () => {
    const flags = getMemoryProtocolFlags();
    expect(flags.readValidation).toBe(true);
    expect(
      parseMemoryProtocolFlags(wireMemoryProtocolFlags(flags))?.readValidation,
    ).toBe(true);
    const { readValidation: _capability, ...absent } = flags;
    expect(parseMemoryProtocolFlags(absent)?.readValidation).toBe(false);
    expect(parseMemoryProtocolFlags({ ...flags, readValidation: "true" }))
      .toBeNull();
  });

  for (const validation of [undefined, "required", "elidable"] as const) {
    it(`${validation === "elidable" ? "issues" : "refuses"} ${validation ?? "unclassified"} reads without server capability`, async () => {
      const server = new Server(testSessionOpenServerOptions);
      const scripted = validationTransport(server, false, false);
      const client = await connect({
        transport: scripted.transport,
      });
      try {
        const session = await client.mount(
          "did:key:read-validation",
          {},
          testSessionOpenAuthFactory,
        );
        if (validation === "elidable") {
          expect((await session.transact(writeCommit(validation))).seq)
            .toBeGreaterThan(0);
          expect(scripted.sent()).toBe(1);
        } else {
          await expect(session.transact(writeCommit(validation))).rejects
            .toThrow("memory server does not support required read validation");
          expect(scripted.sent()).toBe(0);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("refuses before send when the connection changes during request readiness", async () => {
    const server = new Server(testSessionOpenServerOptions);
    const scripted = validationTransport(server, true, false);
    const client = await connect({ transport: scripted.transport });
    try {
      const session = await client.mount(
        "did:key:read-validation",
        {},
        testSessionOpenAuthFactory,
      );
      const pending = session.transact(writeCommit("required"));
      scripted.disconnect();
      await expect(pending).rejects.toThrow(
        "memory server does not support required read validation",
      );
      expect(scripted.sent()).toBe(0);
      expect(scripted.hellos()).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses outstanding required reads when a reconnect loses capability", async () => {
    const server = new Server(testSessionOpenServerOptions);
    const scripted = validationTransport(server, true, true);
    const client = await connect({
      transport: scripted.transport,
    });
    try {
      const session = await client.mount(
        "did:key:read-validation",
        {},
        testSessionOpenAuthFactory,
      );
      await expect(session.transact(writeCommit("required"))).rejects.toThrow(
        "memory server does not support required read validation",
      );
      expect(scripted.sent()).toBe(1);
      expect(scripted.hellos()).toBe(2);
      expect(
        await server.readDocument(
          "did:key:read-validation",
          "of:read-validation",
        ),
      ).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
