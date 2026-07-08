import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// XRootView is a Lit element; load and exercise it under a minimal browser
// shim, mirroring login-view.test.ts. Constructing it runs its field
// initializers (including the runtime Task that reads
// isWorkerConsoleForwardingEnabled), and its pure methods render and report
// state without needing the reactive update lifecycle.
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
    // Minimal render root so Lit's connectedCallback (createRenderRoot ->
    // attachShadow -> adoptStyles) runs without a real DOM.
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
    href: "http://localhost:8000/common-knowledge",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

function templateStrings(value: unknown): string {
  const result = value as { strings?: readonly string[] };
  return (result?.strings ?? []).join("");
}

describe("XRootView", () => {
  it("constructs with default app state and renders the app view", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();

      // A fresh root has no resolved space yet, and state() clones out the
      // default app state.
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      const state = view.state();
      expect(state).toBeDefined();
      expect(state).not.toBe(view.app);

      // render() builds the themed app-view template without a live DOM.
      const markup = templateStrings(view.render());
      expect(markup).toContain("cf-theme");
      expect(markup).toContain("x-app-view");
    } finally {
      restore();
    }
  });

  it("guards a browser reload only while the runtime reports pending writes", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      // Stub Lit's render step: connectedCallback enables updating, which would
      // otherwise schedule a real render (createComment etc.) this shim has no
      // DOM for. We exercise the listener registration, not Lit rendering.
      (view as unknown as { performUpdate: () => void }).performUpdate =
        () => {};

      // connect/disconnect register and remove the beforeunload listener.
      view.connectedCallback();
      view.disconnectedCallback();

      const handler = (view as unknown as {
        _onBeforeUnload: (event: { preventDefault: () => void }) => void;
      })._onBeforeUnload;
      let prevented = 0;
      const event = () => ({ preventDefault: () => prevented++ });
      const setRuntime = (runtime: unknown) =>
        (view as unknown as { runtime: unknown }).runtime = runtime;

      // No runtime yet: nothing to lose, so no prompt.
      handler(event());
      expect(prevented).toBe(0);

      // A runtime with no unconfirmed writes: no prompt.
      setRuntime({ hasPendingWrites: () => false });
      handler(event());
      expect(prevented).toBe(0);

      // Unconfirmed writes in flight: prompt the user before unload.
      setRuntime({ hasPendingWrites: () => true });
      handler(event());
      expect(prevented).toBe(1);
    } finally {
      restore();
    }
  });
});
