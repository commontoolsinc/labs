import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  classifyRenderedHtml,
  PATTERN_PUBLICATION_MESSAGES,
  syntheticArgument,
} from "../src/pattern-index/publish-render-gate.ts";

/**
 * The argument schema of the sortable table that is live in the index and
 * renders every cell as `[object Object]`, copied from what `getPattern`
 * answers for it. The `default: []` on both optional arrays is the trap: a
 * generator that honors defaults builds a table with no rows and no columns,
 * which renders cleanly and publishes the defect.
 */
const LIVE_SORTABLE_TABLE_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      anyOf: [
        { type: "array", items: { $ref: "#/$defs/Row" } },
        { type: "undefined" },
      ],
      default: [],
    },
    columns: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "undefined" },
      ],
      default: [],
    },
  },
  $defs: {
    Row: {
      type: "object",
      properties: {},
      additionalProperties: { type: "unknown" },
    },
  },
} as const;

describe("publish-render-gate", () => {
  describe("syntheticArgument()", () => {
    it("gives a pattern that declares no arguments the empty instance, in full", () => {
      expect(syntheticArgument(false)).toEqual({ value: {}, complete: true });
    });

    it("reports a schema declaring no shape as an instance it could not complete", () => {
      // `{}` is a legal instance of `true`, and says nothing about what would
      // have exercised the pattern — so an empty render under it is evidence
      // about the instance rather than about the pattern.
      expect(syntheticArgument(true)).toEqual({ value: {}, complete: false });
      expect(syntheticArgument(undefined)).toEqual({
        value: {},
        complete: false,
      });
    });

    it("fills every declared property, required or not", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          required: { type: "string" },
          optional: { type: "integer" },
          flag: { type: "boolean" },
        },
        required: ["required"],
      });
      expect(value).toEqual({
        required: "alpha",
        optional: 2,
        flag: true,
      });
    });

    it("gives an array more than one item", () => {
      // One item cannot distinguish a renderer that maps from one that
      // renders only its first element.
      const { value } = syntheticArgument({
        type: "object",
        properties: { names: { type: "array", items: { type: "string" } } },
      });
      expect((value as { names: string[] }).names).toHaveLength(2);
    });

    it("takes the arm of an optional union that supplies the field", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          maybe: {
            anyOf: [{ type: "undefined" }, { type: "string" }],
          },
        },
      });
      expect((value as { maybe: unknown }).maybe).toBe("alpha");
    });

    it("ignores `default`, which is the least exercising instance a schema admits", () => {
      const { value } = syntheticArgument(LIVE_SORTABLE_TABLE_SCHEMA);
      const argument = value as { rows: unknown[]; columns: string[] };
      expect(argument.rows).toHaveLength(2);
      expect(argument.columns).toHaveLength(2);
      // The live defect needs a row to index and a column to index it by,
      // and the column has to name a key the row actually has. Under
      // `default: []` there would be neither row nor column; drawn from two
      // vocabularies the lookup would find nothing and the table would
      // render two empty cells and pass.
      expect(Object.keys(argument.rows[0] as object)).toEqual(
        argument.columns,
      );
    });

    it("reports the live sortable table's instance as partial", () => {
      // Its unions, its open `Row` and its `unknown` values are each a choice
      // the schema left open and the generator made.
      expect(syntheticArgument(LIVE_SORTABLE_TABLE_SCHEMA).complete).toBe(
        false,
      );
    });

    it("stops at a cyclic $ref rather than following it", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              child: { $ref: "#/$defs/Node" },
            },
          },
        },
      });
      expect(complete).toBe(false);
      expect(value).toEqual({ node: { name: "alpha" } });
    });

    it("takes a const and the first member of an enum", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          kind: { const: "fixed" },
          mode: { enum: ["first", "second"] },
        },
      });
      expect(value).toEqual({ kind: "fixed", mode: "first" });
    });
  });

  describe("classifyRenderedHtml()", () => {
    it("refuses output carrying a default-toString marker", () => {
      expect(classifyRenderedHtml("<td>[object Object]</td>")).toBe(
        "ui-default-tostring",
      );
    });

    it("refuses the whole default-toString family, not one spelling of it", () => {
      // The defect is a value stringified by `Object.prototype.toString`;
      // which internal class it names is incidental.
      expect(classifyRenderedHtml("<p>[object Map]</p>")).toBe(
        "ui-default-tostring",
      );
      expect(classifyRenderedHtml("<p>[object Function]</p>")).toBe(
        "ui-default-tostring",
      );
    });

    it("does not read prose that merely resembles the marker as one", () => {
      expect(classifyRenderedHtml("<p>[object oriented]</p>")).toBe(
        "ui-rendered",
      );
    });

    it("names an output whose tree carries nothing at all", () => {
      expect(classifyRenderedHtml("   \n  ")).toBe("ui-rendered-empty");
      // What an empty fragment renders as, which is not literally empty.
      expect(classifyRenderedHtml("<cf-fragment></cf-fragment>")).toBe(
        "ui-rendered-empty",
      );
    });

    it("reads a form of labelled fields as rendered, though it carries no text", () => {
      // `email.tsx` in the seed corpus, verbatim. Weighing text alone hid it.
      expect(
        classifyRenderedHtml(
          '<cf-vstack gap="3"><cf-field label="Email"><cf-input value="[binding]" placeholder="email@example.com" type="email"></cf-input></cf-field></cf-vstack>',
        ),
      ).toBe("ui-rendered");
    });

    it("passes output that rendered content", () => {
      expect(classifyRenderedHtml("<table><tr><td>Avery</td></tr></table>"))
        .toBe("ui-rendered");
    });
  });

  describe("PATTERN_PUBLICATION_MESSAGES", () => {
    it("claims a checkable property and not that the component works", () => {
      const passed = PATTERN_PUBLICATION_MESSAGES["ui-rendered"];
      expect(passed).toContain("That is all this certifies");
      expect(passed).toContain("not that the component works");
    });

    it("says of the one refusing verdict where its evidence went", () => {
      expect(PATTERN_PUBLICATION_MESSAGES["ui-default-tostring"]).toContain(
        "retained in the run artifact and withheld here",
      );
    });

    it("says of every verdict that the pattern is still recorded", () => {
      for (
        const reason of [
          "ui-default-tostring",
          "ui-rendered-empty",
          "probe-failed",
          "superseded",
        ] as const
      ) {
        expect(PATTERN_PUBLICATION_MESSAGES[reason]).toContain(
          "recorded in the pattern index but NOT offered to search",
        );
      }
      for (const reason of ["ui-rendered", "no-ui"] as const) {
        expect(PATTERN_PUBLICATION_MESSAGES[reason]).toContain(
          "offered to search",
        );
      }
    });

    it("carries no placeholder a caller could interpolate into", () => {
      // Every message is a constant. A message with a slot in it is a message
      // someone will eventually fill from the rendered DOM.
      for (const message of Object.values(PATTERN_PUBLICATION_MESSAGES)) {
        expect(message).not.toMatch(/\$\{|%s|\{\d/);
      }
    });
  });
});
