/**
 * The operator-seeded handle seams: parsing a `--seed-handle` argument,
 * minting seeds into a handle table against the session space, and the
 * announcement text — which must carry tokens and the operator's names only,
 * never the address behind a token.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/runner";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_PATTERN,
} from "../src/contracts/handle-table.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import {
  mintSeededHandles,
  parseSeedHandleArgument,
  seededHandlesContextMessage,
} from "../src/seeded-handles.ts";

const SPACE_DID =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as MemorySpace;
const SEED_ID = `of:fid1:${"A".repeat(43)}`;
const SEED_REF = `/${SEED_ID}/travellerName`;
const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForSeededHandleTest/of:fid1:${
  "B".repeat(43)
}/x`;

describe("seeded-handles", () => {
  describe("parseSeedHandleArgument()", () => {
    it("parses a name and reference", () => {
      expect(parseSeedHandleArgument(`travellerName=${SEED_REF}`)).toEqual({
        name: "travellerName",
        ref: SEED_REF,
      });
    });

    it("parses a schema file option after the reference", () => {
      expect(
        parseSeedHandleArgument(`cities=${SEED_REF};schema=cities.json`),
      ).toEqual({
        name: "cities",
        ref: SEED_REF,
        schemaFile: "cities.json",
      });
    });

    it("throws for an argument without a name/reference separator", () => {
      expect(() => parseSeedHandleArgument(SEED_REF)).toThrow(
        "<name>=<link>",
      );
    });

    it("throws for a name outside the word-and-hyphen shape", () => {
      expect(() => parseSeedHandleArgument(`bad name=${SEED_REF}`)).toThrow(
        "name must match",
      );
    });

    it("throws for an empty reference", () => {
      expect(() => parseSeedHandleArgument("seed=")).toThrow(
        "names no reference",
      );
    });

    it("throws for an option other than schema=", () => {
      expect(() => parseSeedHandleArgument(`seed=${SEED_REF};shape=x.json`))
        .toThrow("unknown option");
    });

    it("throws when schema= is named twice", () => {
      expect(() =>
        parseSeedHandleArgument(`seed=${SEED_REF};schema=a.json;schema=b.json`)
      ).toThrow("schema= twice");
    });
  });

  describe("mintSeededHandles()", () => {
    it("mints a resolvable token into a fresh table when the run has none", async () => {
      const { table, seeded } = await mintSeededHandles(
        undefined,
        "run-1",
        [{ name: "travellerName", ref: SEED_REF }],
        SPACE_DID,
      );
      expect(seeded.length).toBe(1);
      expect(seeded[0]!.name).toBe("travellerName");
      expect(seeded[0]!.ref).toBe(SEED_REF);
      expect(seeded[0]!.token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(
        true,
      );
      expect(seeded[0]!.token).toMatch(
        new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`),
      );
      expect(table.salt).toBe("run-1");
      expect(resolveHandleToken(table, seeded[0]!.token)).toBeDefined();
    });

    it("records an operator schema on the minted entry", async () => {
      const schema = { type: "string" } as const;
      const { table, seeded } = await mintSeededHandles(
        undefined,
        "run-2",
        [{ name: "travellerName", ref: SEED_REF, schema }],
        SPACE_DID,
      );
      const entry = resolveHandleToken(table, seeded[0]!.token);
      expect(entry?.schema).toEqual(schema);
      expect(entry?.schemaSource).toBe("operator");
    });

    it("extends an existing table without disturbing its entries", async () => {
      const existing = await mintAddressHandle(
        createHarnessHandleTable("run-3"),
        `/of:fid1:${"C".repeat(43)}`,
      );
      const { table, seeded } = await mintSeededHandles(
        existing.table,
        "run-3",
        [{ name: "travellerName", ref: SEED_REF }],
        SPACE_DID,
      );
      expect(table.entries.length).toBe(2);
      expect(resolveHandleToken(table, existing.token)).toBeDefined();
      expect(resolveHandleToken(table, seeded[0]!.token)).toBeDefined();
    });

    it("throws for a reference targeting another space", async () => {
      await expect(
        mintSeededHandles(
          undefined,
          "run-4",
          [{ name: "foreign", ref: FOREIGN_REF }],
          SPACE_DID,
        ),
      ).rejects.toThrow("targets another space");
    });

    it("throws for a reference that does not parse", async () => {
      await expect(
        mintSeededHandles(
          undefined,
          "run-5",
          [{ name: "broken", ref: "not a link" }],
          SPACE_DID,
        ),
      ).rejects.toThrow("does not parse");
    });

    it("throws for a name seeded twice", async () => {
      await expect(
        mintSeededHandles(
          undefined,
          "run-6",
          [
            { name: "travellerName", ref: SEED_REF },
            { name: "travellerName", ref: `/${SEED_ID}/other` },
          ],
          SPACE_DID,
        ),
      ).rejects.toThrow("twice");
    });
  });

  describe("seededHandlesContextMessage()", () => {
    it("returns undefined for an empty seed list", () => {
      expect(seededHandlesContextMessage([])).toBeUndefined();
    });

    it("pairs each token with the operator's name and never discloses the ref", () => {
      const message = seededHandlesContextMessage([{
        name: "travellerName",
        token: "cfh:a:abcdefgh",
        ref: SEED_REF,
      }]);
      expect(message).toContain("cfh:a:abcdefgh");
      expect(message).toContain("travellerName");
      expect(message).not.toContain(SEED_ID);
    });
  });
});
