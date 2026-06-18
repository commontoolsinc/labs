import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME } from "@commonfabric/runtime-client";
import {
  CFProfileBadge,
  profileDisplayFromValue,
  profileTooltipFromValue,
} from "./cf-profile-badge.ts";
import { identitySeal } from "./identity-seal.ts";

const OWNER_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function representsPrincipalLabel(subject: string) {
  return {
    version: 1,
    entries: [{
      path: ["name"],
      label: { integrity: [{ kind: "represents-principal", subject }] },
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function markConnected(element: CFProfileBadge, isConnected = true): void {
  Object.defineProperty(element, "isConnected", {
    configurable: true,
    value: isConnected,
  });
}

/**
 * A resolved-cell stub for the navigation tests: a root cell (empty `path`) is a
 * navigable profile piece; a sub-path cell is not. The minimal `asSchema` /
 * `getCfcLabel` surface keeps `_resolve` + `_refreshVerification` happy.
 */
function navResolvedCell(
  opts: { path: PropertyKey[]; space?: string; id?: string },
) {
  return {
    ref: () => ({ path: opts.path }),
    space: () => opts.space ?? "did:key:zSpace",
    id: () => opts.id ?? "fid1:piece",
    asSchema: () => ({
      subscribe: (cb: (val: unknown) => void) => {
        cb({ name: "Ada" });
        return () => {};
      },
    }),
    getCfcLabel: () => Promise.resolve(undefined),
  };
}

// deno-lint-ignore no-explicit-any
function fakeClick(): any {
  return { stopPropagation() {}, metaKey: false, ctrlKey: false };
}

describe("CFProfileBadge", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-profile-badge")).toBe(CFProfileBadge);
  });

  it("defaults to a medium avatar in the presented state", () => {
    const el = new CFProfileBadge();
    expect(el.size).toBe("md");
  });

  describe("variants (CT-1761)", () => {
    it("defaults to the full variant", () => {
      const el = new CFProfileBadge();
      expect(el.variant).toBe("full");
    });

    it("renders without throwing for every variant in presented + verified states", () => {
      // The render branches (avatar vs seal-dot, name on/off, shield on/off,
      // circle aria-label, inline accent styles) must all be reachable without a
      // DOM. The real visual check is the browser pass; this guards the wiring.
      for (const variant of ["full", "chip", "circle", "hero"] as const) {
        const el = new CFProfileBadge() as any;
        el.variant = variant;
        el._name = "Ada";
        expect(el.render()).toBeTruthy(); // presented

        el._state = "verified";
        el._seal = identitySeal(OWNER_DID);
        expect(el.render()).toBeTruthy(); // verified
      }
    });
  });

  describe("async resolve lifecycle", () => {
    it("does not subscribe when the element disconnects during resolve", async () => {
      const slowResolution = deferred<any>();
      let subscribeCount = 0;
      const resolvedCell = {
        ref: () => ({ path: [] }),
        asSchema: () => ({
          subscribe: () => {
            subscribeCount++;
            return () => {};
          },
        }),
      };
      const cell = {
        resolveAsCell: () => slowResolution.promise,
      } as any;

      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = cell;

      // Kick off the async resolve, then disconnect while it is still awaiting
      // `resolveAsCell()`.
      const resolving = el._resolve();
      el.disconnectedCallback();
      markConnected(el, false);

      // The resolution lands after disconnect — the generation guard (bumped by
      // disconnectedCallback) plus the isConnected check must prevent any
      // subscription on the detached instance.
      slowResolution.resolve(resolvedCell);
      await resolving;

      expect(subscribeCount).toBe(0);
      expect(el._unsubscribe).toBeUndefined();
    });

    it("subscribes when the resolve completes while still connected", async () => {
      const slowResolution = deferred<any>();
      let subscribeCount = 0;
      let unsubscribeCount = 0;
      const resolvedCell = {
        ref: () => ({ path: [] }),
        asSchema: () => ({
          subscribe: (cb: (val: unknown) => void) => {
            subscribeCount++;
            cb({ name: "Ada", avatar: undefined });
            return () => {
              unsubscribeCount++;
            };
          },
        }),
      };
      const cell = {
        resolveAsCell: () => slowResolution.promise,
      } as any;

      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = cell;

      const resolving = el._resolve();
      slowResolution.resolve(resolvedCell);
      await resolving;

      expect(subscribeCount).toBe(1);
      expect(el._name).toBe("Ada");
      expect(typeof el._unsubscribe).toBe("function");

      // disconnectedCallback should tear the live subscription down.
      el.disconnectedCallback();
      expect(unsubscribeCount).toBe(1);
      expect(el._unsubscribe).toBeUndefined();
    });
  });

  describe("verification seal", () => {
    it("enters the verified state and derives the seal from the owner DID", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification(
        representsPrincipalLabel(OWNER_DID),
        el._resolveGeneration,
      );

      expect(el._state).toBe("verified");
      // The seal is the pure DID-derived fingerprint, identical everywhere.
      expect(el._seal?.did).toBe(OWNER_DID);
      expect(el._seal?.hue).toBe(identitySeal(OWNER_DID).hue);
    });

    it("re-derives verification when the label arrives over the subscription (cold self-heals)", async () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      // The subscription delivers (value, cfcLabel). Cold first: value but no
      // label; then the label appears once the profile doc loads — over the
      // SAME subscription, no separate getCfcLabel read.
      let deliver: ((val: unknown, label?: unknown) => void) | undefined;
      const resolved = {
        ref: () => ({ path: [] }),
        space: () => "did:key:zSpace",
        id: () => "fid1:piece",
        asSchema: () => ({
          subscribe: (cb: (val: unknown, label?: unknown) => void) => {
            deliver = cb;
            return () => {};
          },
        }),
      };
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };

      await el._resolve();

      deliver?.({ name: "Ada" }, undefined);
      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();

      // The label-only change (doc loaded) re-fires the subscription.
      deliver?.({ name: "Ada" }, representsPrincipalLabel(OWNER_DID));
      expect(el._state).toBe("verified");
      expect(el._seal?.did).toBe(OWNER_DID);
    });

    it("stays presented (no seal) when the label has no represents-principal atom", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      el._deriveVerification({
        version: 1,
        entries: [{ path: [], label: { integrity: ["profile-link"] } }],
      }, el._resolveGeneration);

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });

    it("clears a prior seal up-front on re-bind, before the new attestation resolves", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      // Simulate an already-verified badge for some other identity.
      el._state = "verified";
      el._seal = identitySeal(OWNER_DID);

      // Re-bind to a different, never-resolving profile. `_resolve` resets the
      // verification synchronously before its first await, so the stale seal
      // must be gone immediately — it never lingers during the async gap.
      el.profile = { resolveAsCell: () => new Promise(() => {}) };
      void el._resolve();

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });

    it("ignores a label delivered after a re-bind (stale generation)", () => {
      const el = new CFProfileBadge() as any;
      markConnected(el, true);

      const staleGeneration = el._resolveGeneration;
      // A re-bind / disconnect bumps the generation.
      el._resolveGeneration++;

      // A subscription callback from the prior binding fires late with a valid
      // attestation — it must NOT flip the badge to verified.
      el._deriveVerification(
        representsPrincipalLabel(OWNER_DID),
        staleGeneration,
      );

      expect(el._state).toBe("presented");
      expect(el._seal).toBeUndefined();
    });
  });

  describe("navigation (CT-1750)", () => {
    it("navigates to the profile page when bound to a root profile cell", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(true);

      let captured: unknown;
      const onNav = (e: Event) => {
        captured = (e as CustomEvent).detail;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(captured).toEqual({
        spaceDid: "did:key:zSpaceX",
        pieceId: "fid1:profileX",
      });
    });

    it("does not navigate when bound to a non-root (derived/sub-path) cell", async () => {
      const resolved = navResolvedCell({ path: ["name"] });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(false);

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });

    it("opens a new tab (not in-place navigate) on cmd/ctrl-click", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceX",
        id: "fid1:profileX",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      // `_navigateToProfile` composes the new-tab URL from `location.href`;
      // Deno has no `location` unless --location is set, so stub it.
      const hadLocation = "location" in globalThis &&
        globalThis.location !== undefined;
      // deno-lint-ignore no-explicit-any
      const origLocation = (globalThis as any).location;
      // deno-lint-ignore no-explicit-any
      const origOpen = (globalThis as any).open;
      let openedUrl: string | undefined;
      let openedTarget: string | undefined;
      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:8000/home" },
        configurable: true,
        writable: true,
      });
      // deno-lint-ignore no-explicit-any
      (globalThis as any).open = (url: string, target: string) => {
        openedUrl = url;
        openedTarget = target;
        return null;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleClick({
          stopPropagation() {},
          metaKey: true,
          ctrlKey: false,
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
        // deno-lint-ignore no-explicit-any
        (globalThis as any).open = origOpen;
        if (hadLocation) {
          Object.defineProperty(globalThis, "location", {
            value: origLocation,
            configurable: true,
            writable: true,
          });
        } else {
          // deno-lint-ignore no-explicit-any
          delete (globalThis as any).location;
        }
      }

      expect(openedTarget).toBe("_blank");
      expect(openedUrl).toContain("fid1:profileX");
      // New-tab must NOT also fire the in-place navigation.
      expect(navigated).toBe(false);
    });

    it("stays non-navigable when noNavigate is set, even on a root cell", async () => {
      // The profile-home self-badge is bound to a `computed()` projection that
      // happens to resolve as a root cell (path []) but is NOT a real piece, so
      // navigating would route to a non-piece cell id. `noNavigate` suppresses
      // it (a root cell would otherwise be navigable — see the first test).
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceN",
        id: "fid1:profileN",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.noNavigate = true;
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      expect(el._navigable).toBe(false);

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        // Even a direct call is guarded (belt-and-braces with `_navigable`).
        el._navigateToProfile(false);
        el._handleClick(fakeClick());
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });

    it("navigates on Enter and Space keydown", async () => {
      const resolved = navResolvedCell({
        path: [],
        space: "did:key:zSpaceK",
        id: "fid1:profileK",
      });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      for (const key of ["Enter", " "]) {
        let captured: unknown;
        let prevented = false;
        const onNav = (e: Event) => {
          captured = (e as CustomEvent).detail;
        };
        globalThis.addEventListener("cf-navigate", onNav);
        try {
          el._handleKeydown({
            key,
            metaKey: false,
            ctrlKey: false,
            preventDefault() {
              prevented = true;
            },
            // deno-lint-ignore no-explicit-any
          } as any);
        } finally {
          globalThis.removeEventListener("cf-navigate", onNav);
        }
        expect(captured).toEqual({
          spaceDid: "did:key:zSpaceK",
          pieceId: "fid1:profileK",
        });
        expect(prevented).toBe(true);
      }
    });

    it("ignores non-activation keydowns", async () => {
      const resolved = navResolvedCell({ path: [] });
      const el = new CFProfileBadge() as any;
      markConnected(el, true);
      el.profile = { resolveAsCell: () => Promise.resolve(resolved) };
      await el._resolve();

      let navigated = false;
      const onNav = () => {
        navigated = true;
      };
      globalThis.addEventListener("cf-navigate", onNav);
      try {
        el._handleKeydown({
          key: "a",
          metaKey: false,
          ctrlKey: false,
          preventDefault() {},
          // deno-lint-ignore no-explicit-any
        } as any);
      } finally {
        globalThis.removeEventListener("cf-navigate", onNav);
      }

      expect(navigated).toBe(false);
    });
  });

  describe("profileDisplayFromValue", () => {
    it("prefers the profile's name field over the cell [NAME]", () => {
      // On main, profile-home's [NAME] is the static placeholder "Profile"
      // (profile-home.tsx:303); the editable `name` field is the real name.
      const val = {
        [NAME]: "Profile",
        name: "Ben",
        avatar: "https://example.com/ben.png",
      };
      expect(profileDisplayFromValue(val)).toEqual({
        name: "Ben",
        avatar: "https://example.com/ben.png",
      });
    });

    it("falls back to the cell [NAME] when the name field is blank", () => {
      const val = { [NAME]: "Ada Lovelace", name: "  ", avatar: "🦊" };
      expect(profileDisplayFromValue(val)).toEqual({
        name: "Ada Lovelace",
        avatar: "🦊",
      });
    });

    it("returns undefined fields for empty / non-object input", () => {
      expect(profileDisplayFromValue(undefined)).toEqual({
        name: undefined,
        avatar: undefined,
      });
      expect(profileDisplayFromValue("nope")).toEqual({
        name: undefined,
        avatar: undefined,
      });
      expect(profileDisplayFromValue({})).toEqual({
        name: undefined,
        avatar: undefined,
      });
    });
  });

  describe("profileTooltipFromValue (CT-1648)", () => {
    it("extracts a trimmed bio and the pinned-element count", () => {
      const val = {
        name: "Ada",
        bio: "  Mathematician & first programmer.  ",
        elements: [{ title: "Counter" }, { title: "Notes" }],
      };
      expect(profileTooltipFromValue(val)).toEqual({
        bio: "Mathematician & first programmer.",
        pinnedCount: 2,
      });
    });

    it("treats a blank bio as none and a missing elements list as zero", () => {
      expect(profileTooltipFromValue({ name: "Ada", bio: "   " })).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });

    it("returns empty details for a projection without bio/elements", () => {
      // The self-view projection ({name, avatar}) carries no bio/elements.
      expect(profileTooltipFromValue({ name: "Ada", avatar: "🦊" })).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });

    it("returns empty details for non-object input", () => {
      expect(profileTooltipFromValue(undefined)).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
      expect(profileTooltipFromValue("nope")).toEqual({
        bio: undefined,
        pinnedCount: 0,
      });
    });
  });
});
