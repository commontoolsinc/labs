// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { assert, assertEquals, assertFalse } from "@std/assert";

import type { XHeaderView as HeaderViewClass } from "../src/views/HeaderView.ts";

// Exercises the lazy favorites-subscription paths in HeaderView. The header
// resolves the home space's default pattern only when its favorites surface is
// first opened (menu open or favorite toggle), not at login, so the home
// pattern's one-time creation does not contend with the user's first write.

// The members the tests drive, typed loosely so fakes can stand in for the
// runtime; the private steps and state are reached through the accessor.
interface HeaderViewLike {
  rt: unknown;
  space: unknown;
  pieceId: unknown;
  menuOpen: boolean;
  accessForTestingOnly: HeaderViewClass["accessForTestingOnly"];
  willUpdate(changed: Map<string, unknown>): void;
  disconnectedCallback(): void;
}

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

  class TestHTMLElement extends EventTarget {}

  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
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

/**
 * A stand-in for the runtime's favorites surface. Counts subscriptions so a
 * test can assert when (and how often) the header asks for favorites, and can
 * reject writes to simulate a disposed runtime.
 */
function makeRuntime(opts: { aborted?: boolean; failWrite?: boolean } = {}) {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const favorites = {
    subscribeFavorites(cb: (favorites: readonly unknown[]) => void) {
      subscribeCount++;
      cb([]);
      return () => {
        unsubscribeCount++;
      };
    },
    addFavorite: () =>
      opts.failWrite
        ? Promise.reject(new Error("write cancelled"))
        : Promise.resolve(),
    removeFavorite: () =>
      opts.failWrite
        ? Promise.reject(new Error("write cancelled"))
        : Promise.resolve(),
  };
  return {
    favorites: () => favorites,
    signal: { aborted: opts.aborted ?? false },
    get subscribeCount() {
      return subscribeCount;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

const fakeEvent = () =>
  ({ preventDefault() {}, stopPropagation() {} }) as unknown as Event;

Deno.test("favorites stay unsubscribed until a runtime exists and a surface opens", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();

    // No runtime yet: requesting the subscription is a no-op.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 0);

    // Runtime present: the first request subscribes exactly once.
    view.rt = rt;
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);

    // Idempotent: a repeat request does not subscribe again.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("a new runtime re-arms the lazy subscription", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");

    // Menu closed when the runtime arrives: stay unsubscribed until it opens.
    const closed = new XHeaderView() as unknown as HeaderViewLike;
    const first = makeRuntime();
    closed.rt = first;
    closed.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 1);

    // Swapping the runtime tears down the old subscription; with the menu
    // closed nothing resubscribes yet, but the next open does.
    closed.willUpdate(new Map([["rt", undefined]]));
    assertEquals(first.unsubscribeCount, 1);
    closed.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 2);

    // Menu already open when the runtime arrives: subscribe immediately.
    const open = new XHeaderView() as unknown as HeaderViewLike;
    const second = makeRuntime();
    open.menuOpen = true;
    open.rt = second;
    open.willUpdate(new Map([["rt", undefined]]));
    assertEquals(second.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("opening the header menu requests the favorites subscription", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();
    view.rt = rt;

    view.accessForTestingOnly.handleLogoClick(fakeEvent());
    assert(view.menuOpen);
    assertEquals(rt.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("toggling a favorite requests the subscription and swallows a disposal race", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");

    // A successful toggle subscribes and clears the in-flight flag.
    const ok = new XHeaderView() as unknown as HeaderViewLike;
    const okRt = makeRuntime();
    ok.rt = okRt;
    ok.space = "did:key:test";
    ok.pieceId = "piece-1";
    await ok.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(okRt.subscribeCount, 1);
    assertFalse(ok.accessForTestingOnly.isFavoriteLoading);

    // A write cancelled by a disposed runtime is swallowed, not surfaced.
    const racing = new XHeaderView() as unknown as HeaderViewLike;
    const racingRt = makeRuntime({ failWrite: true, aborted: true });
    racing.rt = racingRt;
    racing.space = "did:key:test";
    racing.pieceId = "piece-2";
    await racing.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertFalse(racing.accessForTestingOnly.isFavoriteLoading);
  } finally {
    restore();
  }
});

Deno.test("favorites re-subscribe after the header disconnects and reopens", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();
    view.rt = rt;

    // Opening the menu subscribes.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);

    // Disconnecting tears the subscription down.
    view.disconnectedCallback();
    assertEquals(rt.unsubscribeCount, 1);

    // Reopening after reconnect must subscribe again, not skip on stale state.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 2);
  } finally {
    restore();
  }
});
