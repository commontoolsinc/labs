import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  copresenceRoomForField,
  copresenceRoomUrl,
  CopresenceSession,
  decodePresenceServerMessage,
  type PresencePublication,
  type PresenceSocket,
} from "./copresence-client.ts";

const room = "abcdefghijklmnopqrstuv";

class MockSocket implements PresenceSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  readonly #listeners = new Map<string, Array<(event: never) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

function snapshot(participants: unknown[] = []) {
  return JSON.stringify({
    v: 1,
    type: "room.snapshot",
    selfParticipantId: "11111111-1111-4111-8111-111111111111",
    participants,
  });
}

function participant(index: number) {
  return {
    participantId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revision: 1,
    name: `Participant ${index}`,
    focused: false,
    cursor: { epoch: 1, version: 0 },
    selection: null,
    basis: "confirmed",
  };
}

describe("copresence-client", () => {
  describe("copresenceRoomForField()", () => {
    it("keys the room on the complete resolved operation-field identity", () => {
      const field = {
        space: "did:key:space-a",
        branch: "main",
        id: "of:document-a",
        scopeKey: "user:alice",
        path: ["value", "note", "body"],
      } as const;
      const room = copresenceRoomForField(field);

      expect(room).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(copresenceRoomForField({ ...field })).toBe(room);
      expect(room).not.toContain("space-a");
      expect(room).not.toContain("document-a");
      for (
        const changed of [
          { ...field, space: "did:key:space-b" },
          { ...field, branch: "draft" },
          { ...field, id: "computed:document-a" },
          { ...field, scopeKey: "user:bob" },
          { ...field, path: ["value", "note", "title"] },
          { ...field, path: ["value", "note", "body", "nested"] },
        ]
      ) {
        expect(copresenceRoomForField(changed)).not.toBe(room);
      }
      expect(copresenceRoomForField({ ...field, path: ["value", "."] }))
        .not.toBe(
          copresenceRoomForField({ ...field, path: ["value", "", ""] }),
        );
    });
  });

  describe("CopresenceSession", () => {
    describe("constructor()", () => {
      it("opens the versioned endpoint for a validated opaque room", () => {
        expect(copresenceRoomUrl("wss://presence.example", room)).toBe(
          `wss://presence.example/v1/rooms/${room}`,
        );
        expect(() => copresenceRoomUrl("https://presence.example", room))
          .toThrow("WebSocket");
        expect(() => copresenceRoomUrl("wss://presence.example", "guessable"))
          .toThrow("room");
      });
    });

    describe("instance members", () => {
      describe("publish()", () => {
        it("waits for the snapshot and coalesces publication by frame", () => {
          const socket = new MockSocket();
          const frames: FrameRequestCallback[] = [];
          const messages: unknown[] = [];
          const session = new CopresenceSession({
            serviceUrl: "wss://presence.example",
            room,
            createSocket: () => socket,
            scheduleFrame: (callback) => {
              frames.push(callback);
              return frames.length;
            },
            cancelFrame: () => {},
            onMessage: (message) => messages.push(message),
            onFailure: () => {},
          });
          const publication: PresencePublication = {
            name: "Ada",
            focused: true,
            cursor: { epoch: 3, version: 4 },
            selection: {
              ranges: [{ anchor: 1, head: 1, assoc: 0 }],
              main: 0,
            },
            basis: "confirmed" as const,
          };

          session.publish(publication);
          socket.readyState = 1;
          socket.emit("open");
          expect(frames).toHaveLength(0);

          socket.emit("message", { data: snapshot() });
          expect(messages).toHaveLength(1);
          expect(frames).toHaveLength(1);
          session.publish({ ...publication, name: "Grace" });
          frames.shift()?.(0);

          expect(socket.sent).toHaveLength(1);
          expect(JSON.parse(socket.sent[0])).toEqual({
            v: 1,
            type: "participant.upsert",
            revision: 1,
            ...publication,
            name: "Grace",
          });
          expect(() =>
            session.publish({ ...publication, name: "Ada\u0085Lovelace" })
          ).toThrow("name");
          expect(() => session.publish({ ...publication, name: "Ada\ud800" }))
            .toThrow("name");
        });
      });

      describe("dispose()", () => {
        it("cancels pending publication and closes without reporting failure", () => {
          const socket = new MockSocket();
          const cancelled: number[] = [];
          const failures: string[] = [];
          const session = new CopresenceSession({
            serviceUrl: "wss://presence.example",
            room,
            createSocket: () => socket,
            scheduleFrame: () => 7,
            cancelFrame: (handle) => cancelled.push(handle),
            onMessage: () => {},
            onFailure: (category) => failures.push(category),
          });
          socket.readyState = 1;
          socket.emit("message", { data: snapshot() });
          session.publish({
            name: "Ada",
            focused: false,
            cursor: { epoch: 1, version: 0 },
            selection: null,
            basis: "confirmed",
          });

          session.dispose();
          socket.emit("close");
          socket.emit("error");

          expect(cancelled).toEqual([7]);
          expect(socket.closes).toEqual([[1000, "Presence session ended"]]);
          expect(failures).toEqual([]);
        });
      });

      describe("server messages", () => {
        it("reports one protocol failure for malformed messages", () => {
          const socket = new MockSocket();
          const failures: string[] = [];
          new CopresenceSession({
            serviceUrl: "wss://presence.example",
            room,
            createSocket: () => socket,
            onMessage: () => {},
            onFailure: (category) => failures.push(category),
          });

          socket.emit("message", { data: '{"v":2}' });
          socket.emit("error");
          socket.emit("close");

          expect(failures).toEqual(["protocol"]);
          expect(socket.closes).toEqual([[1002, "Presence session failed"]]);
        });

        it("reports a thrown send and closes once when failure disposal reenters", () => {
          const socket = new MockSocket();
          const frames: FrameRequestCallback[] = [];
          const failures: string[] = [];
          const session = new CopresenceSession({
            serviceUrl: "wss://presence.example",
            room,
            createSocket: () => socket,
            scheduleFrame: (callback) => {
              frames.push(callback);
              return frames.length;
            },
            cancelFrame: () => {},
            onMessage: () => {},
            onFailure: (category) => {
              failures.push(category);
              session.dispose();
            },
          });
          socket.readyState = 1;
          socket.send = () => {
            throw new Error("transport failed");
          };
          session.publish({
            name: "Ada",
            focused: false,
            cursor: { epoch: 1, version: 0 },
            selection: null,
            basis: "confirmed",
          });
          socket.emit("message", { data: snapshot() });

          frames.shift()?.(0);
          socket.emit("error");
          socket.emit("close");

          expect(failures).toEqual(["connection"]);
          expect(socket.closes).toEqual([[1002, "Presence session failed"]]);
        });

        it("fails when incremental upserts exceed the participant limit", () => {
          const socket = new MockSocket();
          const failures: string[] = [];
          const messages: unknown[] = [];
          new CopresenceSession({
            serviceUrl: "wss://presence.example",
            room,
            createSocket: () => socket,
            onMessage: (message) => messages.push(message),
            onFailure: (category) => failures.push(category),
          });
          socket.readyState = 1;
          socket.emit("message", {
            data: snapshot(
              Array.from({ length: 128 }, (_, index) => participant(index)),
            ),
          });

          socket.emit("message", {
            data: JSON.stringify({
              v: 1,
              type: "participant.upsert",
              ...participant(128),
            }),
          });

          expect(messages).toHaveLength(1);
          expect(failures).toEqual(["protocol"]);
          expect(socket.closes).toEqual([[1002, "Presence session failed"]]);
        });
      });
    });
  });

  describe("decodePresenceServerMessage()", () => {
    it("decodes participant replacement and rejects extra fields", () => {
      const message = {
        v: 1,
        type: "participant.upsert",
        participantId: "22222222-2222-4222-8222-222222222222",
        revision: 2,
        name: "Ada",
        focused: true,
        cursor: { epoch: 1, version: 3 },
        selection: {
          ranges: [{ anchor: 0, head: 2, assoc: -1 }],
          main: 0,
        },
        basis: "provisional",
      };
      expect(decodePresenceServerMessage(message)).toEqual({
        type: "participant.upsert",
        participant: {
          participantId: "22222222-2222-4222-8222-222222222222",
          revision: 2,
          name: "Ada",
          focused: true,
          cursor: { epoch: 1, version: 3 },
          selection: {
            ranges: [{ anchor: 0, head: 2, assoc: -1 }],
            main: 0,
          },
          basis: "provisional",
        },
      });
      expect(() => decodePresenceServerMessage({ ...message, document: "no" }))
        .toThrow("upsert");
    });

    it("rejects invalid ranges and participant names", () => {
      const participant = {
        participantId: "22222222-2222-4222-8222-222222222222",
        revision: 1,
        name: "Ada",
        focused: true,
        cursor: { epoch: 1, version: 0 },
        selection: {
          ranges: [{ anchor: -1, head: 0, assoc: 0 }],
          main: 0,
        },
        basis: "confirmed",
      };
      expect(() =>
        decodePresenceServerMessage(JSON.parse(snapshot([participant])))
      ).toThrow("range");
      expect(() =>
        decodePresenceServerMessage(JSON.parse(snapshot([{
          ...participant,
          selection: {
            ranges: [{ anchor: 0, head: 0 }],
            main: 0,
          },
        }])))
      ).toThrow("range");
      expect(() =>
        decodePresenceServerMessage(JSON.parse(snapshot([{
          ...participant,
          selection: {
            ranges: [{ anchor: 0, head: 0, assoc: 2 }],
            main: 0,
          },
        }])))
      ).toThrow("range");
      expect(() =>
        decodePresenceServerMessage(JSON.parse(snapshot([{
          ...participant,
          name: "",
          focused: false,
          selection: null,
        }])))
      ).toThrow("name");
      expect(() =>
        decodePresenceServerMessage(JSON.parse(snapshot([{
          ...participant,
          name: "Ada\u0085Lovelace",
        }])))
      ).toThrow("name");
    });
  });
});
