/**
 * Pins the round-trip spelling at the dispatch gate: the address a read emits
 * (`/of:…`), standing where the DECLARED contract puts a reference, converts
 * to the link envelope dispatch already accepts — and the two payloads that
 * could only ever be mistakes at such a position are refused naming it: a
 * string that is no address, and an inline copy that would store a detached
 * document (#5560).
 *
 * The three layers are pinned separately because each can fail alone:
 * `resolveEmittedAddressArguments` decides positions and spellings,
 * `handlerVerbEvents` recovers the contract the decision reads — the handler
 * module in the compiled pattern, the only serialized surface where a
 * reference marker survives link sanitization — and the live half drives a
 * COMPILED, RUN pattern through `executePieceCallable`, so what is asserted
 * is the schema the transformer emits and the runner stores, not what this
 * file assumed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  resolveEmittedAddressArguments,
  VerbInputValidationError,
} from "../lib/callable.ts";
import { executePieceCallable, handlerVerbEvents } from "../lib/piece.ts";

/** A real-shaped piece id, so the address parser judges the spelling and not
 * a malformed hash. */
const ID = "of:fid1:d2cuq3cMqJY3oaG3fkalMq4uO7BgLfBFkvI-Dm-Kk94";
const ADDRESS = `/${ID}`;
const ENVELOPE = { "/": { "link@1": { id: ID } } };

describe("verb-emitted-address", () => {
  describe("resolveEmittedAddressArguments()", () => {
    /** A contract whose one field is a declared reference, marker inline. */
    const inlineMarker: JSONSchema = {
      type: "object",
      properties: {
        on: { type: "object", asCell: ["cell"] },
      },
    };

    it("converts an address string at a reference position into the link envelope", () => {
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, inlineMarker))
        .toEqual({ value: { on: ENVELOPE } });
    });

    // The compiled contract spells a named reference `{$ref: …, asCell: […]}`
    // — the marker rides the REFERENCE SITE. A walk that resolves the `$ref`
    // before looking loses it and converts nothing, which is exactly how the
    // first live probe of this feature failed.
    it("reads the marker off the `$ref` site, where the compiled contract carries it", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
        $defs: { Item: { type: "object", properties: {} } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("reads the marker off the `$ref` target as well", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item" } },
        $defs: { Item: { type: "object", asCell: ["cell"] } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("carries the address's path into the envelope", () => {
      expect(
        resolveEmittedAddressArguments(
          { on: `${ADDRESS}/status` },
          inlineMarker,
        ),
      ).toEqual({
        value: { on: { "/": { "link@1": { id: ID, path: ["status"] } } } },
      });
    });

    it("refuses a string that is not an address, naming the position and the form", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: "not-an-address" },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        '"not-an-address" at <event>.on is not an address — the position ' +
          "declares a reference, and takes the /of:… form a read prints",
      );
    });

    // `#argument` names a piece's arguments cell for commands that take
    // `--input`; as a verb argument it addresses nothing a reference position
    // can hold.
    it("refuses the `#argument` suffix at a reference position", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: `${ADDRESS}#argument` },
        inlineMarker,
      );
      expect(resolved.refusal).toContain("is not an address");
    });

    it("refuses an inline copy at a reference position as a detached document", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: { title: "a copy" } },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        "<event>.on declares a reference, and an inline copy would store a " +
          "detached document rather than an edge — send the address a read " +
          "printed",
      );
    });

    it("passes a link envelope through untouched", () => {
      const payload = { on: ENVELOPE };
      expect(resolveEmittedAddressArguments(payload, inlineMarker))
        .toEqual({ value: payload });
    });

    it("leaves a string at an unmarked position for shape validation", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { type: "object" } },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    // The event root is where the payload ITSELF sits; a marker there says
    // how the runtime holds the event, not that the caller sends an address.
    it("never converts at the event root", () => {
      const schema: JSONSchema = {
        type: "object",
        asCell: ["cell"],
        properties: { on: { type: "object" } },
      };
      expect(resolveEmittedAddressArguments(ADDRESS, schema))
        .toEqual({ value: ADDRESS });
    });

    it("walks arrays by `items`, and indexes the position a refusal names", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          them: { type: "array", items: { type: "object", asCell: ["cell"] } },
        },
      };
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, ADDRESS] }, schema),
      ).toEqual({ value: { them: [ENVELOPE, ENVELOPE] } });
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, "nope"] }, schema)
          .refusal,
      ).toContain('"nope" at <event>.them[1] is not an address');
    });

    it("walks `prefixItems` by position", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [
              { type: "string" },
              { type: "object", asCell: ["cell"] },
            ],
          },
        },
      };
      expect(
        resolveEmittedAddressArguments({ pair: ["label", ADDRESS] }, schema),
      ).toEqual({ value: { pair: ["label", ENVELOPE] } });
    });

    it("walks a conjunction member-wise", () => {
      const schema: JSONSchema = {
        allOf: [{
          type: "object",
          properties: { on: { type: "object", asCell: ["cell"] } },
        }],
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    // Choosing a disjunction branch is the caller's; converting inside one
    // would pick it for them.
    it("passes over disjunction interiors", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          on: {
            anyOf: [{ type: "object", asCell: ["cell"] }, { type: "null" }],
          },
        },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    it("flows a field the contract does not name through untouched", () => {
      const payload = { on: ADDRESS, extra: ADDRESS };
      const resolved = resolveEmittedAddressArguments(payload, inlineMarker);
      expect((resolved.value as { extra: unknown }).extra).toBe(ADDRESS);
    });

    it("converts nothing without a contract", () => {
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, undefined))
        .toEqual({ value: payload });
    });
  });

  describe("handlerVerbEvents()", () => {
    const link = (n: number) => ({
      $alias: { partialCause: { n }, path: ["stream"], scope: "space" },
    });
    const eventDef: JSONSchema = {
      type: "object",
      properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
    };

    it("resolves a `$ref` event against the module schema's own root", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: { $ref: "#/$defs/E" }, $ctx: true },
              $defs: { E: eventDef, Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      // Self-contained: the interior `$ref` must stay resolvable without the
      // pattern in hand.
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    it("attaches the module root's `$defs` to an inline event", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: eventDef, $ctx: true },
              $defs: { Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    // A stream two handler nodes share is still a verb, but it names no
    // single contract — matching what its declared result does.
    it("maps a stream two handler nodes share to `undefined`", () => {
      const argumentSchema = {
        type: "object",
        properties: { $event: eventDef, $ctx: true },
      };
      const pattern = {
        result: { relate: link(1) },
        nodes: [
          { inputs: { $event: link(1) }, module: { argumentSchema } },
          { inputs: { $event: link(1) }, module: { argumentSchema } },
        ],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("keys a matched node whose module states no schema, as `undefined`", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{ inputs: { $event: link(1) }, module: {} }],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("omits a result property no handler node drives", () => {
      const pattern = {
        result: { data: link(1) },
        nodes: [{ inputs: { $event: link(2) }, module: {} }],
      };
      expect(handlerVerbEvents(pattern).has("data")).toBe(false);
    });

    it("returns an empty map for a pattern with no result", () => {
      expect(handlerVerbEvents(null).size).toBe(0);
      expect(handlerVerbEvents({}).size).toBe(0);
    });
  });

  describe("dispatch through the compiled contract", () => {
    /**
     * A pattern whose `relate` verb declares a reference — `Writable<>` on the
     * event field is the spelling that compiles to the `asCell` marker the
     * gate reads — beside `note`, a verb of plain data, which is the control:
     * nothing here may touch a payload with no reference positions.
     */
    const PROGRAM = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          'import { action, NAME, pattern, type PatternFactory, type Stream, Writable } from "commonfabric";',
          "",
          "interface Recorded { count: number; }",
          "interface RelateEvent { on: Writable<ProbeOutput>; }",
          "interface NoteEvent { body: string; }",
          "",
          "export interface ProbeOutput {",
          "  [NAME]: string;",
          "  label: string;",
          "  links: ProbeOutput[];",
          "  notes: string[];",
          "  relate: Stream<RelateEvent, Recorded>;",
          "  note: Stream<NoteEvent, Recorded>;",
          "}",
          "",
          "interface ProbeInput { label?: string; }",
          "",
          "export const Probe: PatternFactory<ProbeInput, ProbeOutput> = pattern<ProbeInput, ProbeOutput>(",
          "  () => {",
          "    const links = new Writable<ProbeOutput[]>([]);",
          "    const notes = new Writable<string[]>([]);",
          "    const relate = action<RelateEvent, Recorded>((event) => {",
          "      const target = event.on;",
          "      if (!target) throw new Error('relate: on must name a piece');",
          "      links.push(target);",
          "      return { count: (links.get() ?? []).length };",
          "    });",
          "    const note = action<NoteEvent, Recorded>((event) => {",
          "      notes.push(event.body);",
          "      return { count: (notes.get() ?? []).length };",
          "    });",
          "    return { [NAME]: 'Probe', label: 'probe-root', links, notes, relate, note };",
          "  },",
          ");",
          "",
          "export default Probe;",
        ].join("\n"),
      }],
    };

    interface Probe {
      /** Dispatch `verb` as `cf piece call` does, `payload` spelled as the
       * one positional JSON argument a caller writes by hand. */
      call: (verb: string, payload: unknown) => Promise<unknown>;
      /** The piece's own address, exactly as a read emits it. */
      address: string;
      /** How many entries `links` holds. */
      linkCount: () => number;
      /** `links[0]` RAW — the sigil link itself where a reference was
       * stored, and the object itself where a copy was. */
      storedRaw: () => unknown;
      /** `links[0]` read THROUGH, so it says where the edge landed. */
      linkedLabel: () => string | undefined;
      notes: () => string[];
      /** How many times the dispatch path loaded the compiled pattern. */
      patternLoads: () => number;
    }

    async function withProbe<T>(
      passphrase: string,
      body: (probe: Probe) => Promise<T>,
    ): Promise<T> {
      const signer = await Identity.fromPassphrase(passphrase);
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      const space = signer.did();
      try {
        const compiled = await runtime.patternManager.compilePattern(
          PROGRAM as never,
          { space },
        );
        const tx = runtime.edit();
        const rootCell = runtime.getCell(
          space,
          "emitted-address",
          undefined,
          tx,
        );
        const root = runtime.run(tx, compiled, {}, rootCell);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await root.pull();

        let patternLoads = 0;
        const piece = {
          result: { getCell: () => Promise.resolve(root) },
          input: { getCell: () => Promise.resolve(root) },
          getCell: () => root,
          getPattern: () => {
            patternLoads++;
            return Promise.resolve(compiled);
          },
        };
        const deps = {
          loadPieces: () =>
            Promise.resolve({ getSpace: () => space, runtime } as never),
          loadPiece: () => Promise.resolve(piece as never),
        };
        const config = {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:live",
          space,
        };

        let dispatched = 0;
        return await body({
          address: createLLMFriendlyLink(
            root.getAsNormalizedFullLink(),
            space,
          ),
          linkCount: () =>
            ((root.key("links").get() ?? []) as unknown[]).length,
          storedRaw: () => root.key("links").key(0).getRaw(),
          linkedLabel: () =>
            root.key("links").key(0).key("label").get() as string | undefined,
          notes: () => (root.key("notes").get() ?? []) as unknown as string[],
          patternLoads: () => patternLoads,
          call: async (verb, payload) => {
            dispatched++;
            return await executePieceCallable(
              config,
              verb,
              ["--json", JSON.stringify(payload)],
              {
                ...deps,
                invocation: { id: `inv-${dispatched}`, session: "sess" },
              } as never,
            );
          },
        });
      } finally {
        await runtime.dispose?.();
        await storageManager.close?.();
      }
    }

    it("dispatches the address a read emits as a reference, and the edge lands on the target", async () => {
      await withProbe("emitted-address-converts", async (probe) => {
        await probe.call("relate", { on: probe.address });
        // A sigil link and not a copy: the raw stored element is the link
        // object itself.
        expect(probe.storedRaw()).toHaveProperty("/");
        // And it points where the address pointed: reading through it lands
        // on the root's own field.
        expect(probe.linkedLabel()).toBe("probe-root");
      });
    });

    it("refuses a string that is not an address, naming the position", async () => {
      await withProbe("emitted-address-refuses-string", async (probe) => {
        await expect(probe.call("relate", { on: "not-an-address" }))
          .rejects.toThrow(VerbInputValidationError);
        await expect(probe.call("relate", { on: "not-an-address" }))
          .rejects.toThrow(
            '"not-an-address" at <event>.on is not an address',
          );
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("refuses an inline copy as a detached document", async () => {
      await withProbe("emitted-address-refuses-copy", async (probe) => {
        await expect(probe.call("relate", { on: { label: "a copy" } }))
          .rejects.toThrow(
            "<event>.on declares a reference, and an inline copy would " +
              "store a detached document",
          );
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("still accepts the hand-assembled link envelope", async () => {
      await withProbe("emitted-address-envelope", async (probe) => {
        const id = probe.address.replace(/^\//, "");
        await probe.call("relate", { on: { "/": { "link@1": { id } } } });
        expect(probe.linkedLabel()).toBe("probe-root");
      });
    });

    it("touches nothing on a verb with no reference positions", async () => {
      await withProbe("emitted-address-plain-verb", async (probe) => {
        await probe.call("note", { body: "plain data" });
        expect(probe.notes()).toEqual(["plain data"]);
      });
    });

    // The dispatch-cost contract: a payload the published shape accepts goes
    // out without loading the compiled pattern; only the repair path — the
    // conversion or one of its refusals — pays that load, and pays it once.
    it("loads the pattern on the conversion path alone", async () => {
      await withProbe("emitted-address-load-cost", async (probe) => {
        await probe.call("note", { body: "no load" });
        expect(probe.patternLoads()).toBe(0);
        await probe.call("relate", { on: probe.address });
        expect(probe.patternLoads()).toBe(1);
      });
    });
  });
});
