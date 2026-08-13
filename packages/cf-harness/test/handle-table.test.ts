import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_ALPHABET,
  HANDLE_TOKEN_PATTERN,
  HARNESS_HANDLE_TABLE_TYPE,
  type HarnessHandleTable,
  MIN_HANDLE_TOKEN_SUFFIX_LENGTH,
} from "../src/contracts/handle-table.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  type HandleTokenHasher,
  mintAddressHandle,
  resolveHandleToken,
  swapLinksForTokens,
  swapTokensForRefs,
} from "../src/handle-table.ts";

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const LINK_A = `/of:fid1:${HASH_A}`;
const LINK_B = `/of:fid1:${HASH_B}`;
const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/**
 * A hasher that yields the same digest for every first-attempt preimage
 * (`<salt>\0<key>`, two segments) and a different digest once a retry
 * counter joins the preimage, forcing exactly one suffix collision.
 */
const collidingHasher: HandleTokenHasher = (input) => {
  const segments = new TextDecoder().decode(input).split("\0");
  return Promise.resolve(
    new Uint8Array(32).fill(segments.length > 2 ? 1 : 0),
  );
};

const tokenPattern = () => new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`);

describe("handle-table", () => {
  describe("createHarnessHandleTable()", () => {
    it("returns an empty version-1 table salted with the given salt", () => {
      expect(createHarnessHandleTable("run-1")).toEqual({
        type: HARNESS_HANDLE_TABLE_TYPE,
        version: 1,
        salt: "run-1",
        entries: [],
      });
    });
  });

  describe("mintAddressHandle()", () => {
    it("returns a well-formed token drawn from the handle alphabet", async () => {
      const { token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(token).toMatch(tokenPattern());
      expect(token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(true);
      const suffix = token.slice(ADDRESS_HANDLE_TOKEN_PREFIX.length);
      expect(suffix.length).toBe(MIN_HANDLE_TOKEN_SUFFIX_LENGTH);
      for (const char of suffix) {
        expect(HANDLE_TOKEN_ALPHABET.includes(char)).toBe(true);
      }
    });

    it("returns the same token for the same salt and ref across separate table instances", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(second.token).toBe(first.token);
    });

    it("returns different tokens for the same ref under different salts", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        createHarnessHandleTable("run-2"),
        LINK_A,
      );
      expect(second.token).not.toBe(first.token);
    });

    it("returns the existing token without adding an entry when the same ref is minted twice", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_A);
      expect(second.token).toBe(first.token);
      expect(second.table.entries.length).toBe(1);
    });

    it("returns one token for an LLM-friendly link and the bare entity URI of the same cell", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(
        first.table,
        `of:fid1:${HASH_A}`,
      );
      expect(second.token).toBe(first.token);
      expect(second.table.entries.length).toBe(1);
    });

    it("returns one token for the `@space`-suffixed and unsuffixed spellings of a link", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, `${LINK_A}@space`);
      expect(second.token).toBe(first.token);
    });

    it("stores the canonical ref, space DID and path included, for a cross-space link", async () => {
      const ref = `/@${SPACE_DID}${LINK_A}/items/0`;
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        ref,
      );
      expect(resolveHandleToken(table, token)?.ref).toBe(ref);
    });

    it("re-derives a fixed-width suffix on collision, keeping both tokens five characters and distinct", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
        collidingHasher,
      );
      const second = await mintAddressHandle(
        first.table,
        LINK_B,
        collidingHasher,
      );
      expect(first.token).toBe(
        ADDRESS_HANDLE_TOKEN_PREFIX +
          HANDLE_TOKEN_ALPHABET[0].repeat(MIN_HANDLE_TOKEN_SUFFIX_LENGTH),
      );
      expect(second.token).toBe(
        ADDRESS_HANDLE_TOKEN_PREFIX +
          HANDLE_TOKEN_ALPHABET[1].repeat(MIN_HANDLE_TOKEN_SUFFIX_LENGTH),
      );
      expect(first.token.length).toBe(second.token.length);
      expect(second.table.entries.length).toBe(2);
    });

    it("throws for a bare tagged hash without an entity URI scheme", async () => {
      await expect(
        mintAddressHandle(
          createHarnessHandleTable("run-1"),
          `fid1:${HASH_A}`,
        ),
      ).rejects.toThrow();
    });

    it("throws for an `opaque:`-schemed handle", async () => {
      await expect(
        mintAddressHandle(
          createHarnessHandleTable("run-1"),
          `opaque:${HASH_A}`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("resolveHandleToken()", () => {
    it("returns the entry holding the token", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(resolveHandleToken(table, token)).toEqual({
        token,
        kind: "address",
        ref: LINK_A,
        addressKey: table.entries[0].addressKey,
      });
    });

    it("returns `undefined` for a token the table does not hold", () => {
      const table = createHarnessHandleTable("run-1");
      expect(resolveHandleToken(table, "cfh:a:22222")).toBe(undefined);
    });
  });

  describe("swapLinksForTokens()", () => {
    it("replaces an embedded LLM-friendly link, stopping the path at closing punctuation", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `See ${LINK_A}/items/0, then stop.`,
      );
      const token = table.entries[0].token;
      expect(value).toBe(`See ${token}, then stop.`);
      expect(resolveHandleToken(table, token)?.ref).toBe(`${LINK_A}/items/0`);
    });

    it("replaces a standalone schemed entity URI at a word boundary", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `the cell of:fid1:${HASH_A} holds it`,
      );
      expect(value).toBe(`the cell ${table.entries[0].token} holds it`);
    });

    it("replaces a `computed:`-schemed URI", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `computed:fid1:${HASH_A}`,
      );
      expect(value).toBe(table.entries[0].token);
    });

    it("replaces a cross-space link, DID prefix included", async () => {
      const text = `/@${SPACE_DID}${LINK_A}/items`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(table.entries[0].token);
      expect(table.entries[0].ref).toBe(text);
    });

    it("mints one token for repeated occurrences of the same address", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `${LINK_A} and again ${LINK_A}`,
      );
      const token = table.entries[0].token;
      expect(table.entries.length).toBe(1);
      expect(value).toBe(`${token} and again ${token}`);
    });

    it("leaves a bare `fid1:` hash without a scheme untouched", async () => {
      const text = `hash fid1:${HASH_A} names nothing addressable`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("leaves a `/`-prefixed bare hash untouched", async () => {
      const text = `/fid1:${HASH_A}/path`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("leaves near-miss text untouched: a too-short id and a scheme-like word ending", async () => {
      const text = `of:fid1:abc and proof:fid1:${HASH_A}`;
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(value).toBe(text);
      expect(table.entries).toEqual([]);
    });

    it("replaces a schemed URI carrying a tagged hash with a non-`fid1` tag", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `stored at of:fid9:${HASH_A} today`,
      );
      expect(value).toBe(`stored at ${table.entries[0].token} today`);
      expect(table.entries[0].ref).toBe(`/of:fid9:${HASH_A}`);
    });

    it("consumes an `@space` scope suffix, minting the canonical unsuffixed ref", async () => {
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        `${LINK_A}@space holds it`,
      );
      expect(value).toBe(`${table.entries[0].token} holds it`);
      expect(table.entries[0].ref).toBe(LINK_A);
    });

    it("preserves an own `__proto__` key as data through a swap round-trip", async () => {
      const input = JSON.parse(
        `{"__proto__": {"note": "${LINK_A}"}}`,
      ) as Record<string, unknown>;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      const swappedValue = swapped.value as Record<string, unknown>;
      expect(Object.getPrototypeOf(swappedValue)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(swappedValue, "__proto__")?.value,
      ).toEqual({ note: swapped.table.entries[0].token });
      const restored = swapTokensForRefs(
        swapped.table,
        swappedValue,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(restored, "__proto__")?.value,
      ).toEqual({ note: LINK_A });
    });

    it("replaces a single-key `@link` object wholesale with the token string", async () => {
      const input = { note: { "@link": `${LINK_A}/title` } };
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(value).toEqual({ note: table.entries[0].token });
    });

    it("leaves an `@link` object with an `opaque:` handle untouched", async () => {
      const input = { note: { "@link": "opaque:abcdefghij1234567890" } };
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(value).toEqual(input);
      expect(table.entries).toEqual([]);
    });

    it("walks arrays and nested objects without mutating the input", async () => {
      const input = {
        items: [`${LINK_A}/a`, { deep: `see of:fid1:${HASH_B}` }],
      };
      const snapshot = structuredClone(input);
      const { table, value } = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(input).toEqual(snapshot);
      expect(value).toEqual({
        items: [
          table.entries[0].token,
          { deep: `see ${table.entries[1].token}` },
        ],
      });
    });
  });

  describe("swapTokensForRefs()", () => {
    it("restores canonical link text swapped out by `swapLinksForTokens()`", async () => {
      const text = `Read ${LINK_A}/items/0 and of:fid1:${HASH_B} now`;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      expect(swapTokensForRefs(swapped.table, swapped.value)).toBe(
        `Read ${LINK_A}/items/0 and ${LINK_B} now`,
      );
    });

    it("restores refs across arrays and nested objects", async () => {
      const input = { items: [`${LINK_A}/a`], meta: { link: LINK_B } };
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        input,
      );
      expect(swapTokensForRefs(swapped.table, swapped.value)).toEqual(input);
    });

    it("leaves a well-formed token the table does not hold untouched", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const text = "see cfh:a:99999 for details";
      expect(swapTokensForRefs(table, text)).toBe(text);
    });

    it("leaves a longer alphabet run that starts with a held token untouched while replacing the standalone token", async () => {
      const { table, token } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const longer = `${token}xyz`;
      const text = `real ${token} beside fake ${longer} end`;
      expect(swapTokensForRefs(table, text)).toBe(
        `real ${LINK_A} beside fake ${longer} end`,
      );
    });
  });

  describe("assertValidHarnessHandleTable()", () => {
    it("accepts a freshly minted table", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      expect(() => assertValidHarnessHandleTable(table)).not.toThrow();
    });

    it("throws for an unsupported version", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        version: 2,
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "unsupported handle table version: 2",
      );
    });

    it("throws for a wrong type discriminator", () => {
      const table = {
        ...createHarnessHandleTable("run-1"),
        type: "cf-harness.other",
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(table)).toThrow(
        "type must be",
      );
    });

    it("throws for an empty salt", () => {
      expect(() => assertValidHarnessHandleTable(createHarnessHandleTable("")))
        .toThrow("salt must be a non-empty string");
    });

    it("throws for a token outside the token grammar", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], token: "cfh:a:1!" }],
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "malformed token",
      );
    });

    it("throws for an entry kind other than `address`", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], kind: "value" }],
      } as unknown as HarnessHandleTable;
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "entry kind must be `address`",
      );
    });

    it("throws for an entry with an empty ref", async () => {
      const { table } = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const broken = {
        ...table,
        entries: [{ ...table.entries[0], ref: "" }],
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "empty ref",
      );
    });

    it("throws for a duplicate token", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_B);
      const broken = {
        ...second.table,
        entries: second.table.entries.map((entry) => ({
          ...entry,
          token: first.token,
        })),
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "duplicate token",
      );
    });

    it("throws for a duplicate addressKey", async () => {
      const first = await mintAddressHandle(
        createHarnessHandleTable("run-1"),
        LINK_A,
      );
      const second = await mintAddressHandle(first.table, LINK_B);
      const broken = {
        ...second.table,
        entries: second.table.entries.map((entry) => ({
          ...entry,
          addressKey: second.table.entries[0].addressKey,
        })),
      };
      expect(() => assertValidHarnessHandleTable(broken)).toThrow(
        "duplicate addressKey",
      );
    });
  });

  describe("serialized table round trip", () => {
    it("behaves identically after JSON serialization and back", async () => {
      const text = `Read ${LINK_A}/items/0 now`;
      const swapped = await swapLinksForTokens(
        createHarnessHandleTable("run-1"),
        text,
      );
      const rehydrated = JSON.parse(
        JSON.stringify(swapped.table),
      ) as HarnessHandleTable;
      expect(rehydrated).toEqual(swapped.table);
      expect(swapTokensForRefs(rehydrated, swapped.value)).toBe(text);
      const reminted = await mintAddressHandle(
        rehydrated,
        `${LINK_A}/items/0`,
      );
      expect(reminted.token).toBe(rehydrated.entries[0].token);
      expect(reminted.table.entries.length).toBe(1);
    });
  });
});
