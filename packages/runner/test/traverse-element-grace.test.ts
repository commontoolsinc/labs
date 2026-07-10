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
 *
 * Plus the generation-skew sibling (2026-07-10 topics-dev board outage):
 *
 * 4. An array-element object whose required property KEY is absent from the
 *    stored value (a document written by an older pattern generation, before
 *    the field existed) degrades that field instead of voiding the element
 *    and the whole array — one old-generation element blanked the entire
 *    topics read ("Topics (0)" against an intact doc), including arrays that
 *    also held valid new-generation elements. Outside array elements, and
 *    for keys PRESENT with invalid values, strict semantics stay.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
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

describe("element-level required grace for absent keys (generation skew)", () => {
  // A newer pattern generation's output schema requires a field that an
  // older generation never wrote. Modeled on the 2026-07-10 topics-dev
  // board outage: TopicOutput gained composer/edit fields (#4643), and one
  // old-generation sub-piece result blanked the board's whole topics read.
  const topicSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      editingBody: { type: "boolean" },
    },
    required: ["title", "editingBody"],
  } as const satisfies JSONSchema;

  const boardSchema = {
    type: "object",
    properties: {
      topics: { type: "array", items: topicSchema },
    },
    required: ["topics"],
  } as const satisfies JSONSchema;

  const rootUri = "of:board-root" as URI;
  const oldTopicUri = "of:topic-old-gen" as URI;
  const newTopicUri = "of:topic-new-gen" as URI;

  it("degrades a required key an older-generation element never wrote, instead of voiding the array", () => {
    const store = new Map<string, Revision<State>>();
    putDoc(store, oldTopicUri, { title: "written before the field existed" });
    const rootValue = { topics: [linkTo(oldTopicUri)] };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      boardSchema,
    );

    expect(error).toBeUndefined();
    const topics = (result as { topics: { title: string }[] }).topics;
    expect(topics.length).toBe(1);
    expect(topics[0].title).toBe("written before the field existed");
  });

  it("keeps every element of a mixed-generation array readable", () => {
    // The outage's cruelest symptom: ONE old-generation element blanked
    // arrays that also held fully-valid new-generation elements.
    const store = new Map<string, Revision<State>>();
    putDoc(store, oldTopicUri, { title: "old gen" });
    putDoc(store, newTopicUri, { title: "new gen", editingBody: false }, 2);
    const rootValue = { topics: [linkTo(oldTopicUri), linkTo(newTopicUri)] };
    putDoc(store, rootUri, rootValue, 3);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      boardSchema,
    );

    expect(error).toBeUndefined();
    const topics = (result as {
      topics: { title: string; editingBody?: boolean }[];
    }).topics;
    expect(topics.length).toBe(2);
    expect(topics[0].title).toBe("old gen");
    expect(topics[1]).toEqual({ title: "new gen", editingBody: false });
  });

  it("exempts an absent required asCell key in query mode without materializing it", () => {
    // The composer/edit affordances that triggered the outage are
    // Writable/Stream outputs — asCell-marked in the generated schema. This
    // harness runs the QUERY lane (traverseCells=true), whose contract is
    // exemption only: the element survives with the key omitted. The
    // cell.get lane's stronger contract (a live Cell at the absent field's
    // path) is pinned in schema-links.test.ts.
    const withDraftSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        draft: { type: "string", asCell: ["cell"] },
      },
      required: ["title", "draft"],
    } as const satisfies JSONSchema;
    const listWithDraftSchema = {
      type: "object",
      properties: {
        topics: { type: "array", items: withDraftSchema },
      },
      required: ["topics"],
    } as const satisfies JSONSchema;

    const store = new Map<string, Revision<State>>();
    putDoc(store, oldTopicUri, { title: "old gen" });
    const rootValue = { topics: [linkTo(oldTopicUri)] };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listWithDraftSchema,
    );

    expect(error).toBeUndefined();
    const topics =
      (result as { topics: { title: string; draft?: unknown }[] }).topics;
    expect(topics.length).toBe(1);
    expect(topics[0].title).toBe("old gen");
  });

  it("keeps strict required semantics for absent keys outside array elements", () => {
    // Same old-generation shape read as a plain object (not an array
    // element): the read must void so the scheduler defers consumers until
    // the argument materializes.
    const store = new Map<string, Revision<State>>();
    const rootValue = { title: "old gen" };
    putDoc(store, rootUri, rootValue);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      topicSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it("keeps strict semantics for a key that is present but fails its schema", () => {
    // The grace reads absence as schema evolution; a PRESENT key with an
    // invalid value is corruption and must still void (and with it the
    // containing array — mirroring the B2 mask-guard).
    const store = new Map<string, Revision<State>>();
    putDoc(store, oldTopicUri, { title: "bad", editingBody: "not-a-boolean" });
    const rootValue = { topics: [linkTo(oldTopicUri)] };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      boardSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });
});

describe("generation-skew degrade diagnosability", () => {
  // The 2026-07-10 outage was SILENT — no diagnostic anywhere pointed at the
  // blanked array. Pin that every degrade signature and the remaining strict
  // void leave an info breadcrumb on the traverse logger (message bodies are
  // lazy lambdas: they only run — and only help an operator — when the level
  // admits them).
  it("emits an info breadcrumb for each degrade signature and the strict void", () => {
    const traverseLogger = getLogger("traverse");
    const priorLevel = traverseLogger.level;
    traverseLogger.level = "info";
    try {
      const infoCount = () => {
        const breakdown = getLoggerCountsBreakdown()["traverse"] as
          | Record<string, { info?: number }>
          | undefined;
        return breakdown?.["traverse"]?.info ?? 0;
      };
      const rootUri = "of:diag-root" as URI;
      const oldUri = "of:diag-old-gen" as URI;
      const badUri = "of:diag-bad" as URI;
      const itemSchema = {
        type: "object",
        properties: {
          title: { type: "string" },
          editingBody: { type: "boolean" },
          // An explicitly unsatisfiable subschema — the shape combineSchema
          // produces for a field an old element-link schema never knew.
          ghost: false,
        },
        required: ["title", "editingBody", "ghost"],
      } as const satisfies JSONSchema;
      const listSchema = {
        type: "object",
        properties: { topics: { type: "array", items: itemSchema } },
        required: ["topics"],
      } as const satisfies JSONSchema;

      // Degrades: `editingBody` absent (signature 2) + `ghost` unsatisfiable
      // (signature 1) — the element survives, two breadcrumbs.
      const store = new Map<string, Revision<State>>();
      putDoc(store, oldUri, { title: "old gen" });
      const degradeRoot = { topics: [linkTo(oldUri)] };
      putDoc(store, rootUri, degradeRoot, 2);
      const before = infoCount();
      const { ok: degraded, error: degradeError } = traverseRoot(
        store,
        rootUri,
        degradeRoot,
        listSchema,
      );
      expect(degradeError).toBeUndefined();
      expect(
        (degraded as { topics: { title: string }[] }).topics[0].title,
      ).toBe("old gen");
      const afterDegrades = infoCount();
      expect(afterDegrades - before).toBeGreaterThanOrEqual(2);

      // Strict void (present key, satisfiable schema, invalid value): the
      // whole-array void logs its index + address at info.
      const voidStore = new Map<string, Revision<State>>();
      putDoc(voidStore, badUri, {
        title: "bad",
        editingBody: "not-a-boolean",
        ghost: undefined,
      });
      const voidRoot = { topics: [linkTo(badUri)] };
      putDoc(voidStore, rootUri, voidRoot, 2);
      const { ok: voided } = traverseRoot(
        voidStore,
        rootUri,
        voidRoot,
        listSchema,
      );
      expect(voided).toBeUndefined();
      expect(infoCount() - afterDegrades).toBeGreaterThanOrEqual(1);
    } finally {
      traverseLogger.level = priorLevel;
    }
  });
});
