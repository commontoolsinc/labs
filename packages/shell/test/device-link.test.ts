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
      assertEquals(consumeDeviceLinkFragment(), entropy);
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
      assertEquals(consumeDeviceLinkFragment(), null);
      assertEquals(ctx.replaced, ["/loom-jun-12/home"]);
    } finally {
      ctx.restore();
    }
  });

  it("leaves unrelated fragments completely alone", () => {
    const ctx = withLocation("#some-anchor");
    try {
      assertEquals(consumeDeviceLinkFragment(), null);
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
    const identity = await Identity.fromEntropy(ZERO_ENTROPY);
    assertEquals(identity.did(), ZERO_ENTROPY_DID);
  });

  it("round-trips a fragment to the identity it names", async () => {
    // The whole path a scan takes: entropy -> QR text -> fragment -> identity.
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const expected = await Identity.fromEntropy(entropy);

    const parsed = parseDeviceLinkFragment("#k=" + toBase64Url(entropy));
    assert(parsed);
    assertEquals((await Identity.fromEntropy(parsed)).did(), expected.did());
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
    const existing = await Identity.fromEntropy(
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
    const stale = await Identity.fromEntropy(
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
    const stale = await Identity.fromEntropy(
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
    const same = await Identity.fromEntropy(ZERO_ENTROPY);
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
