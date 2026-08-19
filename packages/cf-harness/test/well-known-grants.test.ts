/**
 * The well-known grant seams: resolving the piece-registry reference through
 * a session, minting grant tokens into a handle table, and the fixed
 * announcement text — which must carry tokens and harness-authored prose
 * only, never the address behind a token.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_PATTERN,
} from "../src/contracts/handle-table.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  mintWellKnownGrants,
  resolveWellKnownGrantRefs,
  wellKnownGrantsContextMessage,
} from "../src/well-known-grants.ts";

const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const REGISTRY_ID = `of:fid1:${"A".repeat(43)}`;
const REGISTRY_REF = `/${REGISTRY_ID}/pieceRegistry`;

// A stand-in carrying exactly the two members grant resolution touches.
const stubSession = (): HarnessFabricSession =>
  ({
    pieces: {
      getSpace: () => SPACE_DID,
      getPieceRegistry: () =>
        Promise.resolve({
          getAsNormalizedFullLink: () => ({
            space: SPACE_DID,
            id: REGISTRY_ID,
            path: ["pieceRegistry"],
          }),
        }),
    },
  }) as unknown as HarnessFabricSession;

describe("well-known-grants", () => {
  describe("resolveWellKnownGrantRefs()", () => {
    it("resolves the piece registry to its canonical in-space reference", async () => {
      const refs = await resolveWellKnownGrantRefs(stubSession());
      expect(refs).toEqual([{ name: "piece-registry", ref: REGISTRY_REF }]);
    });
  });

  describe("mintWellKnownGrants()", () => {
    it("mints a resolvable token into a fresh table when the run has none", async () => {
      const { table, grants } = await mintWellKnownGrants(
        undefined,
        "run-1",
        [{ name: "piece-registry", ref: REGISTRY_REF }],
      );
      expect(grants.length).toBe(1);
      expect(grants[0]!.name).toBe("piece-registry");
      expect(grants[0]!.ref).toBe(REGISTRY_REF);
      expect(grants[0]!.token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(
        true,
      );
      expect(grants[0]!.token).toMatch(
        new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`),
      );
      expect(table.salt).toBe("run-1");
      expect(resolveHandleToken(table, grants[0]!.token)).toBeDefined();
    });

    it("extends an existing table without disturbing its entries", async () => {
      const existing = await mintAddressHandle(
        createHarnessHandleTable("run-2"),
        `/of:fid1:${"B".repeat(43)}`,
      );
      const { table, grants } = await mintWellKnownGrants(
        existing.table,
        "run-2",
        [{ name: "piece-registry", ref: REGISTRY_REF }],
      );
      expect(table.entries.length).toBe(2);
      expect(resolveHandleToken(table, existing.token)).toBeDefined();
      expect(resolveHandleToken(table, grants[0]!.token)).toBeDefined();
    });
  });

  describe("wellKnownGrantsContextMessage()", () => {
    it("returns undefined for an empty grant list", () => {
      expect(wellKnownGrantsContextMessage([])).toBeUndefined();
    });

    it("pairs each token with its description and never discloses the ref", () => {
      const message = wellKnownGrantsContextMessage([{
        name: "piece-registry",
        token: "cfh:a:abcdefgh",
        ref: REGISTRY_REF,
      }]);
      expect(message).toContain("cfh:a:abcdefgh");
      expect(message).toContain("piece registry");
      expect(message).not.toContain(REGISTRY_ID);
    });
  });
});
