import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { isACL, sameAcl } from "../acl.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  isEntityDocument,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
} from "../v2.ts";
import { parseClientMessage } from "../v2/server.ts";
import { parseViewInterests, parseViewQuery } from "../v2/view-interest.ts";
import { wireAuthorizationOf } from "../v2/session-open-auth.ts";

/**
 * A record position on the memory wire holds a plain object. Every validator
 * on the peer-input path asks that question, and this file pins the answer at
 * each of them.
 *
 * The values below split into two groups, because the two halves of the
 * boundary admit different things. A validator taking a decoded value can be
 * reached with any object an in-process caller holds, `Date` and `Map`
 * included. A validator taking wire text can only be reached with what the
 * codec decodes, and the codec builds no `Date` and no `Map`: the class
 * instances a peer can place are the codec's own, of which `FabricBytes` is
 * one. Each reads as carrying no properties, which is what makes a
 * field-by-field check pass over one without reading a field.
 */

/** A class instance carrying own enumerable properties. */
class Named {
  readonly type = "hello";
  readonly requestId = "req-1";
}

/** A class instance carrying none. */
class Bare {}

const hostileValues: Array<[string, FabricValue]> = [
  ["a `Date`", new Date(0) as unknown as FabricValue],
  ["a `Map`", new Map([["a", 1]]) as unknown as FabricValue],
  [
    "a class instance with own properties",
    new Named() as unknown as FabricValue,
  ],
  [
    "a class instance with no own properties",
    new Bare() as unknown as FabricValue,
  ],
  ["a `FabricBytes`", new FabricBytes(new Uint8Array([1, 2, 3]))],
];

/** The wire form of a `FabricBytes`, which decodes to a class instance. */
const BYTES = '{"/Bytes@1":"AQID"}';

/** The wire form of an unrecognized tag, which decodes to an `UnknownValue`. */
const UNKNOWN = '{"/Date@1":0}';

const wireInstances: Array<[string, string]> = [
  ["a `FabricBytes`", BYTES],
  ["an unrecognized tagged value", UNKNOWN],
];

const wire = (body: string): string => `fvj1:${body}`;

const flags = JSON.stringify(getMemoryProtocolFlags());

describe("wire record shape", () => {
  describe("parseClientMessage()", () => {
    it("returns a message for a `hello` whose envelope is a plain object", () => {
      expect(
        parseClientMessage(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
        })),
      ).toEqual({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      });
    });

    for (const [label, body] of wireInstances) {
      it(`returns \`null\` for a message that is ${label}`, () => {
        expect(parseClientMessage(wire(body))).toBe(null);
      });

      it(`returns \`null\` for a \`hello\` whose \`flags\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"hello","protocol":${
                JSON.stringify(MEMORY_PROTOCOL)
              },"flags":${body}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`returns \`null\` for a \`session.open\` whose \`session\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"session.open","requestId":"r","space":"did:key:z6Mk-s",` +
                `"session":${body}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`returns \`null\` for a \`transact\` whose \`commit\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"transact","requestId":"r","space":"did:key:z6Mk-s",` +
                `"sessionId":"s","commit":${body}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`returns \`null\` for a \`sqlite.query\` whose \`db\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"sqlite.query","requestId":"r","space":"did:key:z6Mk-s",` +
                `"sessionId":"s","sql":"SELECT 1","db":${body}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`returns \`null\` for a \`sqlite.query\` whose \`db.tables\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"sqlite.query","requestId":"r","space":"did:key:z6Mk-s",` +
                `"sessionId":"s","sql":"SELECT 1","db":{"id":"db","tables":${body}}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`returns \`null\` for a \`sqlite.query\` whose \`reader\` is ${label}`, () => {
        expect(
          parseClientMessage(
            wire(
              `{"type":"sqlite.query","requestId":"r","space":"did:key:z6Mk-s",` +
                `"sessionId":"s","sql":"SELECT 1","db":{"id":"db"},` +
                `"reader":${body}}`,
            ),
          ),
        ).toBe(null);
      });

      it(`drops a \`sqlite.query\` \`params\` that is ${label}`, () => {
        const parsed = parseClientMessage(
          wire(
            `{"type":"sqlite.query","requestId":"r","space":"did:key:z6Mk-s",` +
              `"sessionId":"s","sql":"SELECT 1","db":{"id":"db"},` +
              `"params":${body}}`,
          ),
        );
        expect(parsed).not.toBe(null);
        expect((parsed as { params?: unknown }).params).toBe(undefined);
      });
    }

    it("returns a `session.open` whose `invocation` is dropped when it is a class instance", () => {
      const parsed = parseClientMessage(
        wire(
          `{"type":"session.open","requestId":"r","space":"did:key:z6Mk-s",` +
            `"session":{},"invocation":${BYTES}}`,
        ),
      );
      expect(parsed).not.toBe(null);
      expect((parsed as { invocation?: unknown }).invocation).toBe(undefined);
    });

    it("returns a `sqlite.query` carrying a plain `params` record", () => {
      const parsed = parseClientMessage(
        wire(
          `{"type":"sqlite.query","requestId":"r","space":"did:key:z6Mk-s",` +
            `"sessionId":"s","sql":"SELECT 1","db":{"id":"db"},` +
            `"params":{"a":1}}`,
        ),
      );
      expect((parsed as { params?: unknown }).params).toEqual({ a: 1 });
    });
  });

  describe("parseMemoryProtocolFlags()", () => {
    it("returns the flags for a plain record", () => {
      expect(parseMemoryProtocolFlags(JSON.parse(flags))).toEqual(
        getMemoryProtocolFlags(),
      );
    });

    for (const [label, value] of hostileValues) {
      it(`returns \`null\` for ${label}`, () => {
        expect(parseMemoryProtocolFlags(value)).toBe(null);
      });
    }
  });

  describe("isEntityDocument()", () => {
    it("returns `true` for a plain document root", () => {
      expect(isEntityDocument({ value: 1 })).toBe(true);
    });

    for (const [label, value] of hostileValues) {
      it(`returns \`false\` for ${label}`, () => {
        expect(isEntityDocument(value)).toBe(false);
      });
    }
  });

  describe("isACL()", () => {
    it("returns `true` for a plain record of capabilities", () => {
      expect(isACL({ "did:key:z6Mk-owner": "OWNER" })).toBe(true);
    });

    for (const [label, value] of hostileValues) {
      // Each of these walks to no entries, so an entry-by-entry check finds
      // nothing to reject and would otherwise call it an ACL.
      it(`returns \`false\` for ${label}`, () => {
        expect(isACL(value)).toBe(false);
      });
    }
  });

  describe("parseViewQuery()", () => {
    const root = {
      id: "of:one",
      selector: { path: ["value"] },
    };

    it("returns the query for a plain record", () => {
      expect(parseViewQuery({ roots: [root] })).toEqual({ roots: [root] });
    });

    for (const [label, value] of hostileValues) {
      it(`returns \`null\` for a query that is ${label}`, () => {
        expect(parseViewQuery(value)).toBe(null);
      });

      it(`returns \`null\` for a root that is ${label}`, () => {
        expect(parseViewQuery({ roots: [value] })).toBe(null);
      });

      it(`returns \`null\` for a selector that is ${label}`, () => {
        expect(parseViewQuery({ roots: [{ id: "of:one", selector: value }] }))
          .toBe(null);
      });

      // A schema position takes a record or a boolean, and this is the one
      // position here that a following field check does not reach.
      it(`returns \`null\` for a selector schema that is ${label}`, () => {
        expect(
          parseViewQuery({
            roots: [{
              id: "of:one",
              selector: { path: ["value"], schema: value },
            }],
          }),
        ).toBe(null);
      });
    }
  });

  describe("parseViewInterests()", () => {
    for (const [label, value] of hostileValues) {
      it(`returns \`null\` for a view interest that is ${label}`, () => {
        expect(parseViewInterests([value])).toBe(null);
      });
    }
  });

  describe("sameAcl()", () => {
    it("returns `true` for a plain record equal to the expectation", () => {
      expect(sameAcl({ "did:key:z6Mk-owner": "OWNER" }, {
        "did:key:z6Mk-owner": "OWNER",
      })).toBe(true);
    });

    for (const [label, value] of hostileValues) {
      it(`returns \`false\` for ${label} against an empty expectation`, () => {
        expect(sameAcl(value, {})).toBe(false);
      });
    }
  });

  describe("wireAuthorizationOf()", () => {
    it("returns the narrowed authorization for a plain record", () => {
      const signature = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(wireAuthorizationOf({ signature })).toEqual({ signature });
    });

    for (const [label, value] of hostileValues) {
      it(`returns \`undefined\` for ${label}`, () => {
        expect(wireAuthorizationOf(value)).toBe(undefined);
      });
    }
  });
});
