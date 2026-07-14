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
    href: "http://localhost:8000/named",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

describe("XAppView named-space preparation", () => {
  it("prepares the named space before root and selected pattern tasks", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-app-view-named" as DID;
      const names: string[] = [];
      const root = { id: () => "root" };
      const view = new XAppView();
      view.app = {
        view: { spaceName: "notebook" },
      } as never;
      view.space = space;
      view.rt = {
        signal: new AbortController().signal,
        resolveSpaceName: (name: string) => {
          names.push(name);
          return Promise.resolve(space);
        },
        getSpaceRootPattern: () => Promise.resolve(root),
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(view._spaceRootPattern.value).toBe(root);
      expect(names).toEqual(["notebook", "notebook"]);
    } finally {
      restore();
    }
  });
});
