import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFCFCLabel,
  filterCfcLabelView,
  formatCfcLabelAtom,
} from "./cf-cfc-label.ts";

describe("CFCFCLabel", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-cfc-label")).toBe(CFCFCLabel);
  });

  it("creates an element instance", () => {
    const element = new CFCFCLabel();
    expect(element).toBeInstanceOf(CFCFCLabel);
  });

  it("loads the label view through the bound value", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { classification: ["prompt-risk"] },
      }],
    };
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });
});

describe("cf-cfc-label formatting", () => {
  it("formats string and object atoms without losing kind fields", () => {
    expect(formatCfcLabelAtom("prompt-risk")).toBe("prompt-risk");
    expect(formatCfcLabelAtom({
      kind: "prompt-influence",
      source: "gmail",
    })).toBe('{"kind":"prompt-influence","source":"gmail"}');
  });

  it("filters label entries by atom and kind", () => {
    const view = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          classification: [
            "prompt-risk",
            { kind: "prompt-influence", source: "gmail" },
          ],
          integrity: ["trusted-disclaimer"],
        },
      }],
    };

    expect(filterCfcLabelView(view, { atom: "prompt-risk" })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { classification: ["prompt-risk"] },
      }],
    });
    expect(filterCfcLabelView(view, { kind: "prompt-influence" })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          classification: [{ kind: "prompt-influence", source: "gmail" }],
        },
      }],
    });
  });
});
