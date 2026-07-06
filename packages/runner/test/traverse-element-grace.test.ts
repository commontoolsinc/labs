/**
 * Element-level required grace (the B2 reader-blackout fix, #4532) — unit
 * pins for the three contracts, in the fast runner lane:
 *
 * 1. An array-element object whose required property is a link to an ABSENT
 *    target (unwritten / cross-space not loaded / another principal's
 *    partition) degrades that field instead of voiding the element and the
 *    whole array — the multiplayer "rows never load" blackout.
 * 2. The same shape OUTSIDE an array element keeps strict `required`
 *    semantics and voids — the scheduler relies on that invalidation to
 *    defer lifts/handlers until their arguments materialize (the blanket
 *    version of the fix broke auth-manager patterns exactly here).
 * 3. A link target that EXISTS but fails the schema keeps strict semantics
 *    even inside an element — the grace must not mask a genuine schema
 *    error as a silently-missing field (cubic P1 on #4532). Note absence
 *    cannot be distinguished by failure code: both cases surface as
 *    INVALID_TYPE, which is why the fix resolves the link and checks the
 *    target value rather than matching a code.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashOf } from "@commonfabric/data-model/value-hash";
import type { SchemaPathSelector } from "@commonfabric/api";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(tx, selector);
}

function putDoc(
  store: Map<string, Revision<State>>,
  uri: URI,
  value: unknown,
  since = 1,
): void {
  const revision: Revision<State> = {
    the: TYPE,
    of: uri as Entity,
    is: { value },
    cause: hashOf({ the: TYPE, of: uri as Entity }),
    since,
  };
  store.set(`${revision.of}/${revision.the}`, revision);
}

const linkTo = (id: URI, path: string[] = []) => ({
  "/": { [LINK_V1_TAG]: { id, path } },
});

/** Element schema: `profile` is a required link-valued property. */
const messageSchema = {
  type: "object",
  properties: {
    author: { type: "string" },
    profile: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  required: ["author", "profile"],
} as const satisfies JSONSchema;

const listSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: messageSchema },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

function traverseRoot(
  store: Map<string, Revision<State>>,
  rootUri: URI,
  rootValue: unknown,
  schema: JSONSchema,
) {
  const traverser = getTraverser(store, { path: ["value"], schema });
  return traverser.traverse({
    address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
    value: rootValue as FabricValue,
  });
}

describe("element-level required grace for unresolvable links (B2)", () => {
  const rootUri = "of:chat-root" as URI;
  const profileUri = "of:profile-1" as URI;
  const missingUri = "of:profile-missing" as URI;

  it("degrades a required link field whose target is absent, instead of voiding the array", () => {
    const store = new Map<string, Revision<State>>();
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(missingUri) },
      ],
    };
    putDoc(store, rootUri, rootValue);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(error).toBeUndefined();
    const messages = (result as { messages: { author: string }[] }).messages;
    expect(messages.length).toBe(1);
    expect(messages[0].author).toBe("alice");
  });

  it("still resolves elements whose link target exists", () => {
    const store = new Map<string, Revision<State>>();
    putDoc(store, profileUri, { name: "Alice" });
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(profileUri) },
      ],
    };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(error).toBeUndefined();
    const messages = (result as {
      messages: { author: string; profile: { name: string } }[];
    }).messages;
    expect(messages[0].profile).toEqual({ name: "Alice" });
  });

  it("keeps strict required semantics outside array elements (scheduler deferral contract)", () => {
    // The same absent-target link, but on an object that is NOT an array
    // element: the read must void so the scheduler defers consumers until
    // the argument materializes, rather than running them against an object
    // with a hole where a required property should be.
    const store = new Map<string, Revision<State>>();
    const rootValue = { author: "alice", profile: linkTo(missingUri) };
    putDoc(store, rootUri, rootValue);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      messageSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it("keeps strict semantics for a target that exists but fails the schema", () => {
    // The grace is for ABSENT targets only. A present-but-wrong-shaped
    // target is a genuine schema error; degrading it would silently hide
    // the mismatch (cubic P1 on #4532).
    const store = new Map<string, Revision<State>>();
    putDoc(store, profileUri, "not-an-object");
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(profileUri) },
      ],
    };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });
});
