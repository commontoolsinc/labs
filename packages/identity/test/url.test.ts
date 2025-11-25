import { assertObjectMatch, assertThrows } from "@std/assert";
import { CharmAddress, DidKey, parseCharmAddress } from "../src/url.ts";

const BASE = new URL("http://foo.com");
const SPACE_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsSPACE";
const CHARM_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsCHARM";
const ALICE_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsALICE";

const VALID: [string, CharmAddress][] = [
  ["/globalspace", {
    namespace: undefined,
    space: name("globalspace"),
    charm: undefined,
  }],
  ["/globalspace/charm", {
    namespace: undefined,
    space: name("globalspace"),
    charm: name("charm"),
  }],
  ["/globalspace/charm", {
    namespace: undefined,
    space: name("globalspace"),
    charm: name("charm"),
  }],
  [`/${SPACE_KEY}/charm`, {
    namespace: undefined,
    space: did(SPACE_KEY),
    charm: name("charm"),
  }],
  [`/${SPACE_KEY}/${CHARM_KEY}`, {
    namespace: undefined,
    space: did(SPACE_KEY),
    charm: did(CHARM_KEY),
  }],
  [`/globalspace/${CHARM_KEY}`, {
    namespace: undefined,
    space: name("globalspace"),
    charm: did(CHARM_KEY),
  }],
  [`/${SPACE_KEY}`, {
    namespace: undefined,
    space: did(SPACE_KEY),
    charm: undefined,
  }],
  [`/@${ALICE_KEY}`, {
    namespace: did(ALICE_KEY),
    space: undefined,
    charm: undefined,
  }],
  [`/@${ALICE_KEY}/${SPACE_KEY}`, {
    namespace: did(ALICE_KEY),
    space: did(SPACE_KEY),
    charm: undefined,
  }],
  [`/@${ALICE_KEY}/${SPACE_KEY}/${CHARM_KEY}`, {
    namespace: did(ALICE_KEY),
    space: did(SPACE_KEY),
    charm: did(CHARM_KEY),
  }],
  [`/@${ALICE_KEY}/space/${CHARM_KEY}`, {
    namespace: did(ALICE_KEY),
    space: name("space"),
    charm: did(CHARM_KEY),
  }],
  [`/@${ALICE_KEY}/${SPACE_KEY}/charm`, {
    namespace: did(ALICE_KEY),
    space: did(SPACE_KEY),
    charm: name("charm"),
  }],
  [`/@alice.fab.com/${SPACE_KEY}/charm`, {
    namespace: name("alice.fab.com"),
    space: did(SPACE_KEY),
    charm: name("charm"),
  }],
  ["/@namespace/space/", {
    namespace: name("namespace"),
    space: name("space"),
    charm: undefined,
  }],
];

const INVALID: string[] = [
  "/", // Empty pathname - no first component
  "", // Empty string
  "//space", // Empty first component
  "/space//charm", // Empty second component
  "/@namespace//charm", // Empty space component with namespace
  "/@", // Namespace marker only, no value
  "/@/space", // Empty namespace after @
  "/did:key:", // Malformed DID - no value after did:key:
  "/@did:key:/space", // Empty DID in namespace
  "/space/did:key:", // Empty DID in charm
];

Deno.test("Parses correct CharmAddress", () => {
  for (const [url, expectation] of VALID) {
    assertObjectMatch(
      parseCharmAddress(new URL(url, BASE)),
      expectation,
      `"${url}" is a valid address.`,
    );
  }
});

Deno.test("Throws error on invalid CharmAddress", () => {
  for (const url of INVALID) {
    assertThrows(
      () => parseCharmAddress(new URL(url, BASE)),
      Error,
      "Invalid address",
      `"${url}" is an invalid address.`,
    );
  }
});

function did(value: DidKey) {
  return { did: value, name: undefined };
}

function name(value: string) {
  return { did: undefined, name: value };
}
