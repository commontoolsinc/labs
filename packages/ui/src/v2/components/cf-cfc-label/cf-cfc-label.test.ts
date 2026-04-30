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
        label: { confidentiality: ["prompt-risk"] },
      }],
    };
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("refreshes when the bound value property is assigned", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = new CFCFCLabel();

    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("loads a prebound label view on first update", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    (element as unknown as {
      firstUpdated(changedProperties: Map<PropertyKey, unknown>): void;
    }).firstUpdated(new Map());
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("refreshes the label when a bound cell emits an update", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    let labelCalls = 0;
    let emitUpdate: (() => void) | undefined;
    const element = new CFCFCLabel();

    element.value = {
      getCfcLabel: () =>
        Promise.resolve(labelCalls++ < 2 ? undefined : cfcLabel),
      subscribe: (callback: () => void) => {
        emitUpdate = () => callback();
        callback();
        return () => {};
      },
    };
    await Promise.resolve();

    expect(element.cfcLabel).toBeUndefined();
    if (!emitUpdate) {
      throw new Error("expected cf-cfc-label to subscribe to the bound cell");
    }
    emitUpdate();
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("loads the initial label for a subscribable bound value", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    const element = new CFCFCLabel();

    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
      subscribe: () => () => {},
    };
    await Promise.resolve();

    expect(element.cfcLabel).toEqual(cfcLabel);
  });

  it("does not duplicate label refreshes for the same bound value", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { confidentiality: ["prompt-influence"] },
      }],
    };
    let labelCalls = 0;
    const requestedProperties: (PropertyKey | undefined)[] = [];
    const element = new CFCFCLabel();
    element.value = {
      getCfcLabel: () => {
        labelCalls += 1;
        return Promise.resolve(cfcLabel);
      },
      subscribe: () => () => {},
    };
    const lifecycle = element as unknown as {
      firstUpdated(changedProperties: Map<PropertyKey, unknown>): void;
      updated(changedProperties: Map<PropertyKey, unknown>): void;
    };
    const updateHost = element as unknown as {
      requestUpdate(
        name?: PropertyKey,
        oldValue?: unknown,
        options?: unknown,
      ): void;
    };
    const requestUpdate = updateHost.requestUpdate.bind(updateHost);

    lifecycle.firstUpdated(new Map());
    await Promise.resolve();
    updateHost.requestUpdate = ((
      name?: PropertyKey,
      oldValue?: unknown,
      options?: unknown,
    ) => {
      requestedProperties.push(name);
      requestUpdate(name, oldValue, options);
    }) as typeof updateHost.requestUpdate;
    lifecycle.updated(
      new Map<PropertyKey, unknown>([["value", element.value]]),
    );
    await Promise.resolve();

    expect(labelCalls).toBe(1);
    expect(element.cfcLabel).toEqual(cfcLabel);
    expect(requestedProperties).toContain("cfcLabel");
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
          confidentiality: [
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
        label: { confidentiality: ["prompt-risk"] },
      }],
    });
    expect(filterCfcLabelView(view, { kind: "prompt-influence" })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: [{ kind: "prompt-influence", source: "gmail" }],
        },
      }],
    });
  });
});
