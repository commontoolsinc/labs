import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type ErrorNotification,
  NotificationType,
  RuntimeErrorCode,
} from "@commonfabric/runtime-client";

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

  it("raises the reload banner on a versionSkew, and renders it", async () => {
    const restore = installBrowserGlobals();
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a);
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const bannerSlot = () =>
        (view.render() as { values: unknown[] }).values[0];

      // No banner by default (the conditional renders null).
      expect(bannerSlot()).toBe(null);

      // The worker's versionSkew handler warns and flips the banner state on.
      view._handleVersionSkew({ space: "did:key:x" });
      expect(warnings.length).toBe(1);
      expect(
        (view as unknown as { _versionSkew: boolean })._versionSkew,
      ).toBe(true);

      // Now the banner template is constructed and rendered in the slot.
      const banner = bannerSlot();
      expect(banner).not.toBe(null);
      expect(templateStrings(banner)).toContain("version-skew-banner");
      expect(templateStrings(banner)).toContain("Reload");
    } finally {
      console.warn = origWarn;
      restore();
    }
  });

  it("replaces the current worker after a compiler chunk load failure", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const runs: unknown[] = [];
      const internals = view as unknown as {
        _rt: { run(args: unknown): void };
        _runtimeGeneration: number;
      };
      internals._rt = { run: (args) => runs.push(args) };
      const failedGeneration = internals._runtimeGeneration;
      const event: ErrorNotification = {
        type: NotificationType.ErrorReport,
        message: "Failed to load the compiler stack",
        code: RuntimeErrorCode.CompilerStackLoadFailed,
      };

      view._handleRuntimeError(event, failedGeneration);
      expect(runs).toEqual([[view.app]]);

      // A second signal from the worker being replaced is stale and ignored.
      view._handleRuntimeError(event, failedGeneration);
      expect(runs).toHaveLength(1);

      // Ordinary runtime errors remain diagnostics, not lifecycle events.
      view._handleRuntimeError({
        type: NotificationType.ErrorReport,
        message: "ordinary runtime error",
      });
      expect(runs).toHaveLength(1);
    } finally {
      console.error = originalError;
      restore();
    }
  });

  it("passes a generation-bound error callback to RuntimeInternals", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    const { RuntimeInternals } = await import("@commonfabric/lib-shell");
    const originalCreate = RuntimeInternals.create;
    let capturedOnError: ((event: ErrorNotification) => void) | undefined;
    const fakeRuntime = {};
    RuntimeInternals.create = ((options) => {
      capturedOnError = options.onError;
      return Promise.resolve({
        runtime: () => fakeRuntime,
        dispose: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<typeof RuntimeInternals.create>>);
    }) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      view.app = {
        ...view.app,
        identity: await Identity.fromPassphrase(
          "root-view-runtime-error-callback-test",
        ),
      };
      const task = (view as unknown as {
        _rt: {
          run(args: [typeof view.app]): void;
          taskComplete: Promise<unknown>;
        };
      })._rt;

      task.run([view.app]);
      await task.taskComplete;
      expect(capturedOnError).toBeDefined();

      const event: ErrorNotification = {
        type: NotificationType.ErrorReport,
        message: "ordinary runtime error",
      };
      capturedOnError!(event);
      expect(errors).toContainEqual(["[RuntimeClient Error]", event]);
    } finally {
      RuntimeInternals.create = originalCreate;
      console.error = originalError;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
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
