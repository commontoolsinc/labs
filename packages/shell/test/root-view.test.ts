// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

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
  setGlobal("$PRESENCE_URL", "wss://presence.test");

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
      expect((view as unknown as { presenceUrl?: string }).presenceUrl).toBe(
        "wss://presence.test/",
      );

      // render() builds the themed app-view template without a live DOM.
      const markup = templateStrings(view.render());
      expect(markup).toContain("cf-theme");
      expect(markup).toContain("x-app-view");
    } finally {
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
    let capturedWorkerUrl: URL | undefined;
    const fakeRuntime = {};
    RuntimeInternals.create = ((options) => {
      capturedOnError = options.onError;
      capturedWorkerUrl = options.workerUrl;
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
      expect(capturedWorkerUrl?.pathname).toBe("/scripts/worker-runtime.js");

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

  it("drops the previous space before a differently named view renders", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const { resolveSpaceDid } = await import("@commonfabric/lib-shell");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-named-space-transition-test",
      );
      // willUpdate runs before render, which is the point of the test: what
      // it leaves behind is what the app view is handed.
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const appChanged = new Map<string, unknown>([["app", undefined]]);
      const setView = (next: unknown) => {
        view.app = {
          ...view.app,
          identity,
          view: next as typeof view.app.view,
        };
        lifecycle.willUpdate(appChanged);
      };

      const atlas = await resolveSpaceDid(identity, "atlas");
      const notebook = await resolveSpaceDid(identity, "notebook");
      expect(atlas).not.toBe(notebook);

      // A name is looked up asynchronously, so the view has no space yet.
      setView({ spaceName: "atlas" });
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Moving between pieces of one space keeps the space already resolved.
      setView({ spaceName: "atlas", pieceId: "piece-1" });
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Naming a different space drops the old DID in the same step that
      // adopts the new view, so the two are never rendered together.
      setView({ spaceName: "notebook" });
      expect(view.getRuntimeSpaceDID()).toBeUndefined();
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(notebook);

      // A view addressing its space by DID needs no lookup at all.
      setView({ spaceDid: atlas });
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // The home view addresses the identity's own space.
      setView({ builtin: "home" });
      expect(view.getRuntimeSpaceDID()).toBe(identity.did());
    } finally {
      restore();
    }
  });

  it("starts one lookup per name, whatever else changes in the app state", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const { resolveSpaceDid } = await import("@commonfabric/lib-shell");
      const view = new XRootView();
      const first = await Identity.fromPassphrase("root-view-one-lookup-first");
      const second = await Identity.fromPassphrase(
        "root-view-one-lookup-second",
      );
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };
      const appChanged = new Map<string, unknown>([["app", undefined]]);

      // A named space is keyed off the name and a fixed passphrase, so it is
      // the same space for everyone. Identity has no say in the answer.
      const atlas = await resolveSpaceDid(first, "atlas");
      expect(await resolveSpaceDid(second, "atlas")).toBe(atlas);
      expect(first.did()).not.toBe(second.did());

      view.app = {
        ...view.app,
        identity: first,
        view: { spaceName: "atlas" } as typeof view.app.view,
      };
      lifecycle.willUpdate(appChanged);
      // The promise handed back identifies the lookup now in flight.
      const lookup = view.spaceResolved();

      // An unrelated change while the lookup is still running leaves it be,
      // rather than abandoning it and starting the same lookup over.
      view.app = { ...view.app, config: { showDebuggerView: true } };
      lifecycle.willUpdate(appChanged);
      expect(view.spaceResolved()).toBe(lookup);

      await lookup;
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // Switching identity on the same name keeps the space, and asks again
      // for nothing: the answer cannot have changed.
      view.app = { ...view.app, identity: second };
      lifecycle.willUpdate(appChanged);
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
      expect(view.spaceResolved()).toBe(lookup);

      // Logging out drops the space; logging back in looks it up afresh.
      view.app = { ...view.app, identity: undefined };
      lifecycle.willUpdate(appChanged);
      expect(view.getRuntimeSpaceDID()).toBeUndefined();

      view.app = { ...view.app, identity: second };
      lifecycle.willUpdate(appChanged);
      expect(view.spaceResolved()).not.toBe(lookup);
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
    } finally {
      restore();
    }
  });

  it("keeps the view's space when a superseded runtime creation unwinds", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    const { RuntimeInternals, resolveSpaceDid } = await import(
      "@commonfabric/lib-shell"
    );
    const originalCreate = RuntimeInternals.create;
    // The superseded creation has to be inside RuntimeInternals.create when
    // its replacement starts — a run cancelled earlier (during posture
    // adoption) unwinds without ever building a runtime, which is the other
    // test below. The stub parks the second creation until the test has
    // issued the superseding run, and the abandonment is observed off that
    // creation's own dispose: resolving there lands after the whole
    // abandonment block has run.
    let enteredCreate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCreate = resolve;
    });
    let releaseCreate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let abandoned!: () => void;
    const disposed = new Promise<void>((resolve) => {
      abandoned = resolve;
    });
    let createCount = 0;
    RuntimeInternals.create = (async () => {
      const index = ++createCount;
      if (index === 1) {
        enteredCreate();
        await released;
      }
      return {
        runtime: () => ({}),
        dispose: () => {
          if (index === 1) abandoned();
          return Promise.resolve();
        },
      } as unknown as Awaited<
        ReturnType<typeof RuntimeInternals.create>
      >;
    }) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-superseded-runtime-test",
      );
      const atlas = await resolveSpaceDid(identity, "atlas");
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };

      view.app = {
        ...view.app,
        identity,
        view: { spaceName: "atlas" } as typeof view.app.view,
      };
      lifecycle.willUpdate(new Map([["app", undefined]]));
      await view.spaceResolved();
      expect(view.getRuntimeSpaceDID()).toBe(atlas);

      // The Lit update cycle is shimmed away, so nothing auto-runs the
      // task; every creation below is driven by hand and the first manual
      // run's creation is the one the stub parks.
      const task = (view as unknown as {
        _rt: {
          run(args: [typeof view.app]): void;
          taskComplete: Promise<unknown>;
        };
      })._rt;

      // One runtime creation reaches RuntimeInternals.create and a second
      // supersedes it there, which is what a compiler stack reload does to a
      // creation already under way.
      task.run([view.app]);
      await entered;
      task.run([view.app]);
      releaseCreate();
      await task.taskComplete;
      await disposed;

      // The abandoned creation says nothing about which space the view
      // addresses, so the space it resolved has to survive. Nothing would
      // restore it: the view still names atlas, so no lookup runs again.
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
    } finally {
      RuntimeInternals.create = originalCreate;
      console.error = originalError;
      delete (globalThis as { commonfabric?: unknown }).commonfabric;
      restore();
    }
  });

  it("keeps the view's space when a superseded creation cancels before it builds", async () => {
    const restore = installBrowserGlobals();
    const originalError = console.error;
    console.error = () => {};
    const { RuntimeInternals, resolveSpaceDid } = await import(
      "@commonfabric/lib-shell"
    );
    const originalCreate = RuntimeInternals.create;
    let createCount = 0;
    RuntimeInternals.create = (() => {
      createCount++;
      return Promise.resolve({
        runtime: () => ({}),
        dispose: () => Promise.resolve(),
      } as unknown as Awaited<
        ReturnType<typeof RuntimeInternals.create>
      >);
    }) as typeof RuntimeInternals.create;

    try {
      const { XRootView } = await import("../src/views/RootView.ts");
      const view = new XRootView();
      const identity = await Identity.fromPassphrase(
        "root-view-superseded-runtime-test",
      );
      const atlas = await resolveSpaceDid(identity, "atlas");
      const lifecycle = view as unknown as {
        willUpdate(changed: Map<string, unknown>): void;
      };

      view.app = {
        ...view.app,
        identity,
        view: { spaceName: "atlas" } as typeof view.app.view,
      };
      lifecycle.willUpdate(new Map([["app", undefined]]));
      await view.spaceResolved();
      const task = (view as unknown as {
        _rt: {
          run(args: [typeof view.app]): void;
          taskComplete: Promise<unknown>;
        };
      })._rt;

      // Two back-to-back runs: the first's signal is already aborted when its
      // body reaches the posture adoption, which throws the abort before any
      // runtime exists. The cancelled run has nothing to dispose and must
      // leave the view's space alone.
      task.run([view.app]);
      task.run([view.app]);
      await task.taskComplete;

      expect(createCount).toBe(1);
      expect(view.getRuntimeSpaceDID()).toBe(atlas);
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
