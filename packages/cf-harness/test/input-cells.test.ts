/**
 * The operator input-cell seams: parsing a `--input-cell` argument,
 * minting cells' handles into a table against the session space, and the
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
  inputCellsContextMessage,
  mintInputCellHandles,
  parseInputCellArgument,
} from "../src/input-cells.ts";

const SPACE_DID =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as MemorySpace;
const CELL_ID = `of:fid1:${"A".repeat(43)}`;
const CELL_REF = `/${CELL_ID}/travellerName`;
const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForInputCellTest/of:fid1:${
  "B".repeat(43)
}/x`;

describe("input-cells", () => {
  describe("parseInputCellArgument()", () => {
    it("parses a name and reference", () => {
      expect(parseInputCellArgument(`travellerName=${CELL_REF}`)).toEqual({
        name: "travellerName",
        ref: CELL_REF,
      });
    });

    it("parses a schema file option after the reference", () => {
      expect(
        parseInputCellArgument(`cities=${CELL_REF};schema=cities.json`),
      ).toEqual({
        name: "cities",
        ref: CELL_REF,
        schemaFile: "cities.json",
      });
    });

    it("throws for an argument without a name/reference separator", () => {
      expect(() => parseInputCellArgument(CELL_REF)).toThrow(
        "<name>=<link>",
      );
    });

    it("throws for a name outside the word-and-hyphen shape", () => {
      expect(() => parseInputCellArgument(`bad name=${CELL_REF}`)).toThrow(
        "name must match",
      );
    });

    it("throws for an empty reference", () => {
      expect(() => parseInputCellArgument("cities=")).toThrow(
        "names no reference",
      );
    });

    it("throws for an option other than schema=", () => {
      expect(() => parseInputCellArgument(`cities=${CELL_REF};shape=x.json`))
        .toThrow("unknown option");
    });

    it("throws when schema= is named twice", () => {
      expect(() =>
        parseInputCellArgument(`cities=${CELL_REF};schema=a.json;schema=b.json`)
      ).toThrow("schema= twice");
    });
  });

  describe("mintInputCellHandles()", () => {
    it("mints a resolvable token into a fresh table when the run has none", async () => {
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
      );
      expect(inputCells.length).toBe(1);
      expect(inputCells[0]!.name).toBe("travellerName");
      expect(inputCells[0]!.ref).toBe(CELL_REF);
      expect(inputCells[0]!.token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(
        true,
      );
      expect(inputCells[0]!.token).toMatch(
        new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`),
      );
      expect(table.salt).toBe("run-1");
      expect(resolveHandleToken(table, inputCells[0]!.token)).toBeDefined();
    });

    it("records an operator schema on the minted entry", async () => {
      const schema = { type: "string" } as const;
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-2",
        [{ name: "travellerName", ref: CELL_REF, schema }],
        SPACE_DID,
      );
      const entry = resolveHandleToken(table, inputCells[0]!.token);
      expect(entry?.schema).toEqual(schema);
      expect(entry?.schemaSource).toBe("operator");
    });

    it("records the table entry's canonical spelling as the cell's ref", async () => {
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-7",
        [{
          name: "travellerName",
          ref: `/@${SPACE_DID}/${CELL_ID}/travellerName`,
        }],
        SPACE_DID,
      );
      const entry = resolveHandleToken(table, inputCells[0]!.token);
      expect(inputCells[0]!.ref).toBe(entry!.ref);
    });

    it("extends an existing table without disturbing its entries", async () => {
      const existing = await mintAddressHandle(
        createHarnessHandleTable("run-3"),
        `/of:fid1:${"C".repeat(43)}`,
      );
      const { table, inputCells } = await mintInputCellHandles(
        existing.table,
        "run-3",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
      );
      expect(table.entries.length).toBe(2);
      expect(resolveHandleToken(table, existing.token)).toBeDefined();
      expect(resolveHandleToken(table, inputCells[0]!.token)).toBeDefined();
    });

    it("throws for a reference targeting another space", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-4",
          [{ name: "foreign", ref: FOREIGN_REF }],
          SPACE_DID,
        ),
      ).rejects.toThrow("targets another space");
    });

    it("throws for a reference that does not parse", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-5",
          [{ name: "broken", ref: "not a link" }],
          SPACE_DID,
        ),
      ).rejects.toThrow("does not parse");
    });

    it("throws for a name passed twice", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-6",
          [
            { name: "travellerName", ref: CELL_REF },
            { name: "travellerName", ref: `/${CELL_ID}/other` },
          ],
          SPACE_DID,
        ),
      ).rejects.toThrow("twice");
    });
  });

  describe("inputCellsContextMessage()", () => {
    it("returns undefined for an empty input-cell list", () => {
      expect(inputCellsContextMessage([])).toBeUndefined();
    });

    it("pairs each token with the operator's name and never discloses the ref", () => {
      const message = inputCellsContextMessage([{
        name: "travellerName",
        token: "cfh:a:abcdefgh",
        ref: CELL_REF,
      }]);
      expect(message).toContain("cfh:a:abcdefgh");
      expect(message).toContain("travellerName");
      expect(message).not.toContain(CELL_ID);
    });
  });
});
