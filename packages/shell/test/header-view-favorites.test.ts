import { assert, assertEquals, assertFalse } from "@std/assert";

// Exercises the lazy favorites-subscription paths in HeaderView. The header
// resolves the home space's default pattern only when its favorites surface is
// first opened (menu open or favorite toggle), not at login, so the home
// pattern's one-time creation does not contend with the user's first write.

// The members the tests drive, typed loosely so fakes can stand in for the
// runtime and the private methods/state are reachable without leaking `any`.
interface HeaderViewLike {
  rt: unknown;
  space: unknown;
  pieceId: unknown;
  menuOpen: boolean;
  _favoritesSubscriptionRequested: boolean;
  _isFavoriteLoading: boolean;
  _ensureFavoritesSubscription(): void;
  willUpdate(changed: Map<string, unknown>): void;
  handleLogoClick(e: Event): void;
  handleToggleFavorite(e: Event): Promise<void>;
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
  const favorites = {
    subscribeFavorites(cb: (favorites: readonly unknown[]) => void) {
      subscribeCount++;
      cb([]);
      return () => {};
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
    view._ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 0);
    assertFalse(view._favoritesSubscriptionRequested);

    // Runtime present: the first request subscribes exactly once.
    view.rt = rt;
    view._ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);
    assert(view._favoritesSubscriptionRequested);

    // Idempotent: a repeat request does not subscribe again.
    view._ensureFavoritesSubscription();
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
    closed._ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 1);

    closed.willUpdate(new Map([["rt", undefined]]));
    assertFalse(closed._favoritesSubscriptionRequested);
    closed._ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 2);

    // Menu already open when the runtime arrives: subscribe immediately.
    const open = new XHeaderView() as unknown as HeaderViewLike;
    const second = makeRuntime();
    open.menuOpen = true;
    open.rt = second;
    open.willUpdate(new Map([["rt", undefined]]));
    assert(open._favoritesSubscriptionRequested);
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

    view.handleLogoClick(fakeEvent());
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
    await ok.handleToggleFavorite(fakeEvent());
    assertEquals(okRt.subscribeCount, 1);
    assert(ok._favoritesSubscriptionRequested);
    assertFalse(ok._isFavoriteLoading);

    // A write cancelled by a disposed runtime is swallowed, not surfaced.
    const racing = new XHeaderView() as unknown as HeaderViewLike;
    const racingRt = makeRuntime({ failWrite: true, aborted: true });
    racing.rt = racingRt;
    racing.space = "did:key:test";
    racing.pieceId = "piece-2";
    await racing.handleToggleFavorite(fakeEvent());
    assertFalse(racing._isFavoriteLoading);
  } finally {
    restore();
  }
});
