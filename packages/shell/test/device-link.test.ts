import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  consumeDeviceLinkFragment,
  looksLikeDeviceLink,
  parseDeviceLinkFragment,
} from "../src/lib/device-link.ts";
import { runDeviceLinkLogin } from "../src/lib/device-link-login.ts";

// NOTE: this file lives in test/ deliberately. The shell's test task globs
// `test/*.test.ts` ONLY — a co-located src/lib/*.test.ts is silently never run,
// and the verify step would pass with zero coverage.

/** Unpadded base64url, the QR payload encoding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

const ZERO_ENTROPY = new Uint8Array(32);
// The all-zero BIP39 entropy vector, pinned in the identity package too.
const ZERO_ENTROPY_DID =
  "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";

// A deliberately ASYMMETRIC vector (0x00..0x1f). The all-zero vector is a fixed
// point of reversal, rotation and XOR-with-zero, so pinning ONLY against it
// lets a whole class of byte-mangling bugs through — a mutation reversing the
// seed passed the entire suite when this was the only vector.
const COUNTING_ENTROPY = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => i),
);
const COUNTING_ENTROPY_DID =
  "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";

describe("parseDeviceLinkFragment", () => {
  it("decodes a well-formed device link to 32 bytes", () => {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(entropy));
    assert(parsed);
    assertEquals(parsed, entropy);
  });

  it("accepts the all-zero vector", () => {
    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(ZERO_ENTROPY));
    assertEquals(parsed, ZERO_ENTROPY);
  });

  it("rejects anything that is not exactly a device link", () => {
    const valid = toBase64Url(ZERO_ENTROPY);
    for (
      const hash of [
        "",
        "#",
        "#foo=bar",
        "#kk=" + valid,
        "#k=", // empty payload
        "#k=" + valid.slice(0, 42), // too short
        "#k=" + valid + "A", // too long
        "#k=" + valid.slice(0, 42) + "+", // non-base64url character
        "#k=" + valid.slice(0, 42) + "=", // padded
        "#k=" + valid.slice(0, 42) + " ", // whitespace
        "?k=" + valid, // query, not fragment
      ]
    ) {
      assertEquals(
        parseDeviceLinkFragment(hash),
        null,
        `should have rejected: ${JSON.stringify(hash)}`,
      );
    }
  });

  it("is pure — a rejected hash is simply null, never a throw", () => {
    assertEquals(parseDeviceLinkFragment("#k=" + "!".repeat(43)), null);
  });
});

describe("looksLikeDeviceLink", () => {
  it("is true for malformed payloads too, so they still get scrubbed", () => {
    // A malformed payload is still somebody's secret; leaving it in the
    // address bar to be bookmarked or synced is the leak with none of the win.
    assert(looksLikeDeviceLink("#k=garbage"));
    assert(!looksLikeDeviceLink("#other"));
  });
});

describe("consumeDeviceLinkFragment", () => {
  // Minimal stand-ins: the real ones are read straight off globalThis.
  function withLocation(
    hash: string,
    pathname = "/loom-jun-12/home",
    search = "",
  ) {
    const replaced: string[] = [];
    const originalLocation = globalThis.location;
    const originalHistory = globalThis.history;
    Object.defineProperty(globalThis, "location", {
      value: { hash, pathname, search },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "history", {
      value: {
        replaceState: (_s: unknown, _t: string, url: string) => {
          replaced.push(url);
        },
      },
      configurable: true,
      writable: true,
    });
    const restore = () => {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "history", {
        value: originalHistory,
        configurable: true,
        writable: true,
      });
    };
    return { replaced, restore };
  }

  it("returns the entropy and scrubs the fragment", () => {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const ctx = withLocation("#k=" + toBase64Url(entropy));
    try {
      assertEquals(consumeDeviceLinkFragment(), {
        kind: "entropy",
        entropy,
      });
      assertEquals(ctx.replaced, ["/loom-jun-12/home"]);
    } finally {
      ctx.restore();
    }
  });

  it("preserves pathname and search when scrubbing", () => {
    // Load-bearing, not cosmetic: the QR targets a deep link, and the boot must
    // continue to that path so the flow ends inside a logged-in app the user
    // bookmarks. The scrubbed URL is exactly what gets bookmarked.
    const ctx = withLocation(
      "#k=" + toBase64Url(ZERO_ENTROPY),
      "/loom-jun-12/home",
      "?ref=qr",
    );
    try {
      consumeDeviceLinkFragment();
      assertEquals(ctx.replaced, ["/loom-jun-12/home?ref=qr"]);
    } finally {
      ctx.restore();
    }
  });

  it("scrubs even when the payload is malformed", () => {
    const ctx = withLocation("#k=not-valid-entropy");
    try {
      // "malformed", NOT "absent": the scrub already removed it, so the
      // documented "refresh once and rescan" recovery cannot work and the
      // failure has to be surfaced rather than booting as if nothing happened.
      assertEquals(consumeDeviceLinkFragment(), { kind: "malformed" });
      assertEquals(ctx.replaced, ["/loom-jun-12/home"]);
    } finally {
      ctx.restore();
    }
  });

  it("leaves unrelated fragments completely alone", () => {
    const ctx = withLocation("#some-anchor");
    try {
      assertEquals(consumeDeviceLinkFragment(), { kind: "absent" });
      assertEquals(ctx.replaced, []);
    } finally {
      ctx.restore();
    }
  });
});

describe("device-link derivation", () => {
  it("derives the pinned DID from the all-zero entropy vector", async () => {
    // Pins that the shell and the pairing device agree on the derivation. If
    // this DID ever moves, a scanned code signs the phone in as somebody else.
    const identity = await Identity.fromRaw(ZERO_ENTROPY);
    assertEquals(identity.did(), ZERO_ENTROPY_DID);
  });

  it("derives the pinned DID from an ASYMMETRIC vector", async () => {
    // The all-zero vector alone is worthless as a pin: it survives reversal,
    // rotation and XOR-with-zero unchanged, so a seed-mangling bug passes.
    // This vector does not.
    const identity = await Identity.fromRaw(COUNTING_ENTROPY);
    assertEquals(identity.did(), COUNTING_ENTROPY_DID);
  });

  it("byte order matters — a reversed seed is a different identity", async () => {
    const reversed = new Uint8Array([...COUNTING_ENTROPY].reverse());
    const forward = await Identity.fromRaw(COUNTING_ENTROPY);
    const backward = await Identity.fromRaw(reversed);
    assert(
      forward.did() !== backward.did(),
      "reversal must change the identity, or the pins above prove nothing",
    );
  });

  it("rejects any entropy length but 32", async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      let threw = false;
      try {
        await Identity.fromRaw(new Uint8Array(length));
      } catch {
        threw = true;
      }
      assert(
        threw,
        `length ${length} must be rejected, not silently truncated`,
      );
    }
  });

  it("round-trips a fragment to the identity it names", async () => {
    // The whole path a scan takes: entropy -> QR text -> fragment -> identity.
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const expected = await Identity.fromRaw(entropy);

    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(entropy));
    assert(parsed);
    assertEquals((await Identity.fromRaw(parsed)).did(), expected.did());
  });

  it("produces a payload that fits the pairing QR's byte budget", () => {
    // The encoder driving the Pair screen's QR caps at 106 bytes, and the
    // hosted deep-link target is already 54 of them. 43 chars is what makes
    // the whole flow fit without touching the encoder.
    const encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    assertEquals(encoded.length, 43);
    assertEquals(new TextEncoder().encode("#k=" + encoded).length, 46);
  });
});

describe("runDeviceLinkLogin", () => {
  /** In-memory stand-in for the IndexedDB-backed KeyStore. */
  function fakeKeyStore(initial?: Identity) {
    const entries = new Map<string, Identity>();
    if (initial) entries.set("$ROOT_KEY", initial);
    return {
      store: {
        // deno-lint-ignore require-await
        get: async (name: string) => entries.get(name),
        // deno-lint-ignore require-await
        set: async (name: string, value: Identity) => {
          entries.set(name, value);
        },
        // deno-lint-ignore no-explicit-any
      } as any,
      entries,
    };
  }

  it("stores the new identity when confirmed", async () => {
    const { store, entries } = fakeKeyStore();
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "accepted");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("does not touch the KeyStore when the user cancels", async () => {
    const existing = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store, entries } = fakeKeyStore(existing);
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(false),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "cancelled");
    assertEquals(entries.get("$ROOT_KEY")?.did(), existing.did());
  });

  it("REPLACES a different existing identity when confirmed", async () => {
    // The case a LoginView-only handler would silently no-op on, and the one
    // App.setIdentity refuses outright ("Cannot change identity while logged
    // in") — which is why this writes ROOT_KEY directly, pre-initializeKeys.
    const stale = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store, entries } = fakeKeyStore(stale);
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "accepted");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("shows BOTH DIDs to the confirm gate when replacing", async () => {
    // The confirm screen is the ONLY defence against a donated-identity link,
    // so it must be handed the DIDs a user can cross-check against the Pair
    // screen — not a truncation or a placeholder.
    const stale = await Identity.fromRaw(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { store } = fakeKeyStore(stale);
    let seen: [string, string | null] | null = null;
    await runDeviceLinkLogin(
      ZERO_ENTROPY,
      (incoming, current) => {
        seen = [incoming, current];
        return Promise.resolve(false);
      },
      () => Promise.resolve(store),
    );
    assertEquals(seen, [ZERO_ENTROPY_DID, stale.did()]);
  });

  it("passes a null current DID on a fresh device", async () => {
    const { store } = fakeKeyStore();
    let current: string | null | undefined;
    await runDeviceLinkLogin(
      ZERO_ENTROPY,
      (_incoming, currentDid) => {
        current = currentDid;
        return Promise.resolve(false);
      },
      () => Promise.resolve(store),
    );
    assertEquals(current, null);
  });

  it("re-scanning the same code is a no-op write", async () => {
    const same = await Identity.fromRaw(ZERO_ENTROPY);
    const { store, entries } = fakeKeyStore(same);
    let wrote = false;
    store.set = () => {
      wrote = true;
      return Promise.resolve();
    };
    const outcome = await runDeviceLinkLogin(
      ZERO_ENTROPY,
      () => Promise.resolve(true),
      () => Promise.resolve(store),
    );
    assertEquals(outcome, "accepted");
    assert(!wrote, "should not churn the stored key when nothing changed");
    assertEquals(entries.get("$ROOT_KEY")?.did(), ZERO_ENTROPY_DID);
  });

  it("reports invalid entropy without prompting or opening the store", async () => {
    let prompted = false;
    let opened = false;
    const outcome = await runDeviceLinkLogin(
      new Uint8Array(3), // not a valid ed25519 seed
      () => {
        prompted = true;
        return Promise.resolve(true);
      },
      () => {
        opened = true;
        return Promise.resolve(fakeKeyStore().store);
      },
    );
    assertEquals(outcome, "invalid");
    assert(!prompted, "must not prompt for undecodable entropy");
    assert(!opened, "must not open the KeyStore for undecodable entropy");
  });
});

// ── the confirm gate itself ────────────────────────────────────────────────
//
// Previously uncovered: every test above injects its own `confirm`, so the
// production path and the whole view were unexercised. Two mutations passed the
// entire suite as a result — `confirmWithUser` hardcoded to true, and the Cancel
// button rewired to accept. For the screen the design calls the only defence
// against a donated-identity link, those are the mutations that matter most.
//
// Follows the repo's view-test idiom (see login-view.test.ts): install fake
// browser globals, instantiate the element, and inspect what render() produces.

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
    body: { appendChild() {} },
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
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

// deno-lint-ignore no-explicit-any
function templateText(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";
  return [
    ...(value.strings ?? []),
    ...((value.values ?? []).map(templateText)),
  ].join("");
}

/** Click handlers in template order: [accept, cancel]. */
// deno-lint-ignore no-explicit-any
function handlersOf(value: any): Array<() => void> {
  if (value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(handlersOf);
  const out: Array<() => void> = [];
  for (const v of value.values ?? []) {
    if (typeof v === "function") out.push(v as () => void);
    else out.push(...handlersOf(v));
  }
  return out;
}

describe("DeviceLinkView", () => {
  async function makeView(state: Record<string, unknown>) {
    const { XDeviceLinkView } = await import("../src/views/DeviceLinkView.ts");
    const view = new XDeviceLinkView();
    // `guarded` defaults true (tap-through protection); tests opt out unless
    // they are specifically exercising the guard.
    Object.assign(view, { guarded: false, ...state });
    const answers: boolean[] = [];
    view.addEventListener(
      "device-link-result",
      (e) => answers.push(Boolean((e as CustomEvent).detail?.accepted)),
    );
    return { view, answers };
  }

  it("shows the incoming DID verbatim so it can be cross-checked", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view } = await makeView({ incomingDid: COUNTING_ENTROPY_DID });
      const text = templateText(view.render());
      assert(
        text.includes(COUNTING_ENTROPY_DID),
        "the full DID must be on screen, not truncated",
      );
      assert(
        text.includes("Pair screen"),
        "anti-phishing copy must be present",
      );
    } finally {
      restore();
    }
  });

  it("shows BOTH DIDs and replace wording when replacing", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        currentDid: ZERO_ENTROPY_DID,
      });
      const text = templateText(view.render());
      assert(text.includes(COUNTING_ENTROPY_DID));
      assert(text.includes(ZERO_ENTROPY_DID));
      assert(text.includes("Replace"), "must say it replaces an identity");
    } finally {
      restore();
    }
  });

  it("CANCEL answers no — the button wiring, not just finish()", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      const [accept, cancel] = handlersOf(view.render());
      assert(accept && cancel, "expected an accept and a cancel handler");
      cancel();
      assertEquals(answers, [false], "Cancel must answer NO");
    } finally {
      restore();
    }
  });

  it("the primary button answers yes", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      handlersOf(view.render())[0]();
      assertEquals(answers, [true]);
    } finally {
      restore();
    }
  });

  it("ignores an accept that lands inside the tap-through guard", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        guarded: true, // as it is for the first moments on screen
      });
      handlersOf(view.render())[0]();
      assertEquals(answers, [], "a tap in flight must not accept");
    } finally {
      restore();
    }
  });

  it("still allows CANCEL during the guard", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        guarded: true,
      });
      handlersOf(view.render())[1]();
      assertEquals(answers, [false], "the guard must never trap the user");
    } finally {
      restore();
    }
  });

  it("answers exactly once, even on a double tap", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
      });
      const [accept, cancel] = handlersOf(view.render());
      accept();
      cancel();
      accept();
      assertEquals(answers, [true], "only the first answer counts");
    } finally {
      restore();
    }
  });

  it("the already-signed-in screen cannot answer anything but yes", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({
        incomingDid: COUNTING_ENTROPY_DID,
        currentDid: COUNTING_ENTROPY_DID,
      });
      const text = templateText(view.render());
      assert(text.includes("Already signed in"));
      handlersOf(view.render())[0]();
      assertEquals(answers, [true]);
    } finally {
      restore();
    }
  });

  it("the failure screen explains why a refresh will not help", async () => {
    const restore = installBrowserGlobals();
    try {
      const { view, answers } = await makeView({ failure: "unreadable" });
      const text = templateText(view.render());
      assert(text.includes("could not be read"));
      // The scrub has already removed the code, so the design's documented
      // "refresh once and rescan" cannot work — the copy must say so.
      // Whitespace-normalized: the template is line-wrapped by the formatter.
      assert(
        text.replace(/\s+/g, " ").includes("Reloading this page will not help"),
        text,
      );
      handlersOf(view.render())[0]();
      assertEquals(answers, [false], "the failure screen never accepts");
    } finally {
      restore();
    }
  });
});

describe("confirmWithUser (the production confirm path)", () => {
  it("resolves false when the view answers no", async () => {
    const restore = installBrowserGlobals();
    try {
      // A stand-in element that the real confirmWithUser can drive.
      class FakeView extends EventTarget {
        incomingDid = "";
        currentDid: string | null = null;
        failure: string | null = null;
        remove() {}
      }
      const created: FakeView[] = [];
      // deno-lint-ignore no-explicit-any
      (globalThis as any).document.createElement = () => {
        const el = new FakeView();
        created.push(el);
        return el;
      };
      const { confirmWithUser } = await import(
        "../src/lib/device-link-login.ts"
      );
      const pending = confirmWithUser(COUNTING_ENTROPY_DID, null);
      const el = created[0];
      assertEquals(el.incomingDid, COUNTING_ENTROPY_DID);
      el.dispatchEvent(
        new CustomEvent("device-link-result", { detail: { accepted: false } }),
      );
      assertEquals(await pending, false);
    } finally {
      restore();
    }
  });

  it("resolves true only when the view says so", async () => {
    const restore = installBrowserGlobals();
    try {
      class FakeView extends EventTarget {
        incomingDid = "";
        currentDid: string | null = null;
        remove() {}
      }
      const created: FakeView[] = [];
      // deno-lint-ignore no-explicit-any
      (globalThis as any).document.createElement = () => {
        const el = new FakeView();
        created.push(el);
        return el;
      };
      const { confirmWithUser } = await import(
        "../src/lib/device-link-login.ts"
      );
      const pending = confirmWithUser(COUNTING_ENTROPY_DID, ZERO_ENTROPY_DID);
      assertEquals(created[0].currentDid, ZERO_ENTROPY_DID);
      created[0].dispatchEvent(
        new CustomEvent("device-link-result", { detail: { accepted: true } }),
      );
      assertEquals(await pending, true);
    } finally {
      restore();
    }
  });
});
