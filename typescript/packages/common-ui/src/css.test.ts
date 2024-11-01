import assert from "node:assert/strict";
import {
  camelCaseToKababCase,
  toCssValue,
  prop,
  ruleset,
  stylesheet,
  atoms,
  padding,
  margin,
  paddingStep,
  marginStep,
} from "./css.js";

describe("CSS Utilities", () => {
  describe("camelCaseToKababCase", () => {
    it("should convert camelCase to kabab-case", () => {
      assert.equal(camelCaseToKababCase("backgroundColor"), "background-color");
      assert.equal(camelCaseToKababCase("marginTop"), "margin-top");
      assert.equal(camelCaseToKababCase("simple"), "simple");
    });
  });

  describe("toCssValue", () => {
    it("should convert numbers to pixel values", () => {
      assert.equal(toCssValue(10), "10px");
      assert.equal(toCssValue(0), "0px");
    });

    it("should return strings as-is", () => {
      assert.equal(toCssValue("1rem"), "1rem");
      assert.equal(toCssValue("100%"), "100%");
    });
  });

  describe("prop", () => {
    it("should format CSS property-value pairs", () => {
      assert.equal(prop("marginTop", 10), "margin-top: 10px;");
      assert.equal(prop("color", "red"), "color: red;");
    });
  });

  describe("ruleset", () => {
    it("should create CSS rulesets", () => {
      const result = ruleset(".test", { marginTop: 10, color: "red" });
      const expected = `.test {\nmargin-top: 10px;\ncolor: red;\n}`;
      assert.equal(result.trim(), expected.trim());
    });
  });

  describe("stylesheet", () => {
    it("should create complete stylesheets", () => {
      const styles = {
        ".test1": { marginTop: 10 },
        ".test2": { color: "blue" },
      };
      const result = stylesheet(styles);
      const expected = `.test1 {\nmargin-top: 10px;\n}\n.test2 {\ncolor: blue;\n}`;
      assert.equal(result.trim(), expected.trim());
    });
  });

  describe("atoms", () => {
    it("should transform class names to selector format", () => {
      const input = {
        btn: { padding: "10px" },
        primary: { color: "blue" },
      };
      const result = atoms(input);
      assert.deepStrictEqual(result, {
        ".btn": { padding: "10px" },
        ".primary": { color: "blue" },
      });
    });
  });

  describe("padding", () => {
    it("should generate padding rules", () => {
      const result = padding(10, 20, 30, 40);
      assert.deepStrictEqual(result, {
        paddingTop: 10,
        paddingRight: 20,
        paddingBottom: 30,
        paddingLeft: 40,
      });
    });

    it("should handle null values", () => {
      const result = padding(10, null, 30, null);
      assert.deepStrictEqual(result, {
        paddingTop: 10,
        paddingBottom: 30,
      });
    });
  });

  describe("margin", () => {
    it("should generate margin rules", () => {
      const result = margin(10, 20, 30, 40);
      assert.deepStrictEqual(result, {
        marginTop: 10,
        marginRight: 20,
        marginBottom: 30,
        marginLeft: 40,
      });
    });

    it("should handle null values", () => {
      const result = margin(10, null, 30, null);
      assert.deepStrictEqual(result, {
        marginTop: 10,
        marginBottom: 30,
      });
    });
  });

  describe("paddingStep", () => {
    it("should generate padding utility classes", () => {
      const result = paddingStep(1);
      assert.deepStrictEqual(Object.keys(result), [
        ".p-1",
        ".pt-1",
        ".pr-1",
        ".pb-1",
        ".pl-1",
        ".px-1",
        ".py-1",
      ]);
    });
  });

  describe("marginStep", () => {
    it("should generate margin utility classes", () => {
      const result = marginStep(1);
      assert.deepStrictEqual(Object.keys(result), [
        ".m-1",
        ".mt-1",
        ".mr-1",
        ".mb-1",
        ".ml-1",
        ".mx-1",
        ".my-1",
      ]);
    });
  });
});
