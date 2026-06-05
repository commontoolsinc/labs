import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME } from "@commonfabric/runtime-client";
import { CFProfileBadge, profileDisplayFromValue } from "./cf-profile-badge.ts";

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

describe("CFProfileBadge", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-profile-badge")).toBe(CFProfileBadge);
  });

  it("defaults to a medium avatar in the presented state", () => {
    const el = new CFProfileBadge();
    expect(el.size).toBe("md");
  });

  describe("async resolve lifecycle", () => {
    it("does not subscribe when the element disconnects during resolve", async () => {
      const slowResolution = deferred<any>();
      let subscribeCount = 0;
      const resolvedCell = {
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
});
