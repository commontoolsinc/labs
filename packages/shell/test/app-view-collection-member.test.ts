// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  class TestHTMLElement extends EventTarget {
    attachShadow() {
      return {
        adoptedStyleSheets: [],
        appendChild() {},
        append() {},
      };
    }
  }
  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/naming-demo/top/42",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/** Return the rendered text of nested Lit template results. */
function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  const strings = template.strings ?? [];
  const values = template.values ?? [];
  let text = "";
  for (let index = 0; index < strings.length; index++) {
    text += strings[index];
    if (index < values.length) text += templateText(values[index]);
  }
  return text;
}

const SPACE = "did:key:z6Mk-shell-collection-member" as DID;

describe("AppView collection members", () => {
  it("selects the member the reference names", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const resolved: unknown[][] = [];
      const started: unknown[][] = [];
      const view = new XAppView();
      view.app = {
        identity: {},
        config: {},
        view: { spaceDid: SPACE, pieceSlug: "top", pieceMember: "42" },
      } as never;
      view.space = SPACE;
      view.rt = {
        signal: new AbortController().signal,
        resolveSlug: (...args: unknown[]) => {
          resolved.push(args);
          return Promise.resolve("fid1:member-42");
        },
        getPattern: (...args: unknown[]) => {
          started.push(args);
          return Promise.resolve({ id: () => "fid1:member-42" });
        },
      } as never;

      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(resolved).toEqual([[SPACE, "top", "42"]]);
      // The piece started is the one the reference resolved to, never the
      // document the slug itself lives in.
      expect(started).toEqual([[SPACE, "fid1:member-42"]]);
    } finally {
      restore();
    }
  });

  it("cites a member by a reference carrying its own space", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const view = new XAppView();
      view.app = {
        identity: {},
        config: {},
        view: {
          spaceName: "naming-demo",
          pieceSlug: "top",
          pieceMember: "42",
        },
      } as never;
      view.space = SPACE;

      expect(templateText(view.render())).toContain("/@naming-demo/top/42");
    } finally {
      restore();
    }
  });

  it("cites nothing for a reference that stops at the collection", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const view = new XAppView();
      view.app = {
        identity: {},
        config: {},
        view: { spaceName: "naming-demo", pieceSlug: "top" },
      } as never;
      view.space = SPACE;

      // A collection's name with no member after it names no piece, so there
      // is nothing for a reference to resolve to.
      expect(templateText(view.render())).not.toContain("/@naming-demo/top");
    } finally {
      restore();
    }
  });
});
