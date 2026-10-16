import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type NormalizedFullLink,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadPiecePattern } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { callVerb, pieceVerbs, resultVerbs } from "../src/verb-call.ts";
import { verbInputSchemaError } from "../src/verb-input.ts";

const signer = await Identity.fromPassphrase("piece verb-options");

/** A board of rings: `place` names a ring by the id `rings` lists, which its
 * event declares with `@options`; `addRing` adds one; `clear` names none. */
const RINGS_SOURCE = [
  "import { action, computed, pattern, Stream, Writable } from 'commonfabric';",
  "interface RingSpec { id: string; label: string; }",
  "interface PlaceEvent {",
  "  /** Id of the ring, as `rings` lists it.",
  "   * @options rings[].id rings[].label */",
  "  ring: string;",
  "  step: number;",
  "}",
  "interface NoteCell {",
  "  /** @options rings[].id */",
  "  ring: string;",
  "  step: number;",
  "}",
  "interface PlaceManyEvent { cells: NoteCell[]; }",
  "interface AddRingEvent { id: string; label: string; }",
  "interface Input { setup: Writable<RingSpec[]>; placed: Writable<string[]>; }",
  "interface Output {",
  "  rings: RingSpec[];",
  "  placed: string[];",
  "  place: Stream<PlaceEvent>;",
  "  placeMany: Stream<PlaceManyEvent>;",
  "  addRing: Stream<AddRingEvent>;",
  "  clear: Stream<{ step: number }>;",
  "}",
  "export default pattern<Input, Output>(({ setup, placed }) => {",
  "  const rings = computed(() =>",
  "    setup.get().map((ring) => ({ id: ring.id, label: ring.label }))",
  "  );",
  "  const place = action<PlaceEvent>((event) => {",
  "    placed.push(event.ring);",
  "  });",
  "  const placeMany = action<PlaceManyEvent>((event) => {",
  "    for (const cell of event.cells) placed.push(cell.ring);",
  "  });",
  "  const addRing = action<AddRingEvent>((event) => {",
  "    setup.push(event);",
  "  });",
  "  const clear = action<{ step: number }>(() => {",
  "    placed.set([]);",
  "  });",
  "  return { rings, placed, place, placeMany, addRing, clear };",
  "});",
  "",
].join("\n");

describe("verb options", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let piece: NormalizedFullLink;
  let cell: Cell<{ placed: string[] }>;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
    const created = await pieces.create(RINGS_SOURCE, {
      input: {
        setup: [
          { id: "drums", label: "Drums" },
          { id: "bass", label: "Bass" },
        ],
        placed: [],
      },
    });
    cell = created.getCell() as Cell<{ placed: string[] }>;
    piece = cell.getAsNormalizedFullLink();
    await runtime.idle();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const listed = async (name: string) =>
    (await pieceVerbs(runtime, cell)).find((verb) => verb.name === name);

  const ringOf = (schema: unknown): Record<string, unknown> =>
    (schema as { properties: Record<string, Record<string, unknown>> })
      .properties.ring;

  describe("pieceVerbs()", () => {
    it("lists an annotated property with the options the piece's state holds", async () => {
      const ring = ringOf((await listed("place"))?.inputSchema);

      expect(ring.enum).toEqual(["drums", "bass"]);
      expect(ring["x-enum-labels"]).toEqual(["Drums", "Bass"]);
    });

    it("keeps the annotation beside the options it resolved", async () => {
      const ring = ringOf((await listed("place"))?.inputSchema);

      expect(ring["x-options"]).toEqual({
        value: "rings[].id",
        label: "rings[].label",
      });
    });

    it("resolves an annotated property inside an array's items", async () => {
      // The items are a named type, so the property sits in the definition
      // the items' reference names.
      const schema = (await listed("placeMany"))?.inputSchema as {
        properties: { cells: { items: { $ref: string } } };
        $defs: Record<string, unknown>;
      };
      const items = schema.properties.cells.items.$ref.replace("#/$defs/", "");

      expect(ringOf(schema.$defs[items]).enum).toEqual(["drums", "bass"]);
    });

    it("reads the options from the state as it stands at the listing", async () => {
      await callVerb(runtime, piece, "addRing", { id: "keys", label: "Keys" });
      await runtime.idle();

      const ring = ringOf((await listed("place"))?.inputSchema);

      expect(ring.enum).toEqual(["drums", "bass", "keys"]);
      expect(ring["x-enum-labels"]).toEqual(["Drums", "Bass", "Keys"]);
    });

    it("lists a verb with no annotation exactly as the compiled pattern declares it", async () => {
      const { pattern } = await loadPiecePattern(runtime, cell, piece.space, {
        projectResult: false,
      });
      const declared = resultVerbs(pattern).find((verb) =>
        verb.name === "clear"
      );

      expect((await listed("clear"))?.inputSchema).toEqual(
        declared?.inputSchema,
      );
    });
  });

  describe("callVerb()", () => {
    it("sends a value the options hold", async () => {
      const call = await callVerb(runtime, piece, "place", {
        ring: "bass",
        step: 1,
      });

      expect(call.status).toBe("settled");
      expect(await cell.key("placed").pull()).toEqual(["bass"]);
    });

    it("refuses a value outside the options, naming them, before sending it", async () => {
      const call = await callVerb(runtime, piece, "place", {
        ring: "keys",
        step: 1,
      });

      expect(call).toEqual({
        status: "refused",
        message: 'the event for "place" was refused before it was sent: ' +
          '"keys" at <event>.ring is not one of its options: ' +
          '"drums" (Drums), "bass" (Bass)',
      });
      expect(await cell.key("placed").pull()).toEqual([]);
    });

    it("accepts a value a ring added since the piece started", async () => {
      await callVerb(runtime, piece, "addRing", { id: "keys", label: "Keys" });
      await runtime.idle();

      const call = await callVerb(runtime, piece, "place", {
        ring: "keys",
        step: 1,
      });

      expect(call.status).toBe("settled");
    });
  });

  describe("verbInputSchemaError()", () => {
    const ringSchema = (ring: Record<string, unknown>) => ({
      type: "object" as const,
      properties: { ring },
    });

    it("names the options of an enum that carries no labels", () => {
      const error = verbInputSchemaError(
        { ring: "keys" },
        ringSchema({ type: "string", enum: ["drums", "bass"] }),
      );

      expect(error).toBe(
        '"keys" at <event>.ring is not one of its options: "drums", "bass"',
      );
    });

    it("judges a tuple's prefix positions by their own schemas, not the items'", () => {
      const error = verbInputSchemaError(["head", "tail"], {
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { enum: ["tail"] },
      });

      expect(error).toBeUndefined();
    });

    it("names the options an allOf member gives a position", () => {
      const error = verbInputSchemaError(
        { ring: "keys" },
        ringSchema({ allOf: [{ type: "string" }, { enum: ["drums"] }] }),
      );

      expect(error).toBe(
        '"keys" at <event>.ring is not one of its options: "drums"',
      );
    });

    it("leaves an allOf that refers back to itself to the schema validation", () => {
      const error = verbInputSchemaError({ ring: "keys" }, {
        $ref: "#/$defs/Event",
        $defs: {
          Event: {
            type: "object",
            properties: { ring: { type: "string" } },
            allOf: [{ $ref: "#/$defs/Event" }],
          },
        },
      });

      expect(error).toBe("recursive schema validation made no progress");
    });

    it("leaves an enum holding an object to the schema validation", () => {
      const error = verbInputSchemaError(
        { ring: { id: "keys" } },
        ringSchema({ enum: [{ id: "drums" }] }),
      );

      expect(error).toBe("ring: value is not in enum");
    });
  });
});
