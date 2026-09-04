import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import type { DID } from "@commonfabric/identity";
import type { AppView } from "@commonfabric/navigation";

import type { AppState, ShellApp } from "../src/lib/app-state.ts";
import { Navigation } from "../src/lib/navigation.ts";

// Exercises the class that turns a navigation event into browser history and
// application state. It reads `globalThis.location`, writes `globalThis.history`
// and `document.title`, and listens on `globalThis`; Deno has none of those
// shaped the way a browser does, so each test stands in for them, builds one
// `Navigation` over a recording `ShellApp`, and disposes it before the next.

const SPACE_DID = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

/** What the history and the application saw, in the order it arrived. */
interface Recorded {
  push: Array<{ state: unknown; url: string }>;
  replace: Array<{ state: unknown; url: string }>;
  views: AppView[];
  title: () => string;
}

/** A `ShellApp` that records `setView` and answers the two mapping questions. */
function recordingApp(
  views: AppView[],
  current: { view: AppView; runtimeSpace?: DID },
): ShellApp {
  return {
    state: () => ({ view: current.view } as AppState),
    getRuntimeSpaceDID: () => current.runtimeSpace,
    setView: (view: AppView) => {
      views.push(view);
      current.view = view;
      return Promise.resolve();
    },
    serialize: () => {
      throw new Error("not used");
    },
    setIdentity: () => Promise.resolve(),
    setConfig: () => Promise.resolve(),
  };
}

const restores: Array<() => void> = [];

function setGlobal(name: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  restores.push(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

/** Stand in for the browser, build a `Navigation`, and hand back what it did. */
function withNavigation<T>(
  href: string,
  current: { view: AppView; runtimeSpace?: DID },
  run: (navigation: Navigation, recorded: Recorded) => T,
): T {
  const push: Recorded["push"] = [];
  const replace: Recorded["replace"] = [];
  const views: AppView[] = [];
  let title = "";

  setGlobal("location", { href });
  setGlobal("history", {
    pushState: (state: unknown, _title: string, url: string) =>
      push.push({ state, url }),
    replaceState: (state: unknown, _title: string, url: string) =>
      replace.push({ state, url }),
  });
  setGlobal("document", {
    set title(value: string) {
      title = value;
    },
    get title() {
      return title;
    },
  });

  const navigation = new Navigation(recordingApp(views, current));
  restores.push(() => navigation.dispose());
  return run(navigation, { push, replace, views, title: () => title });
}

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

describe("navigation", () => {
  it("reflects the URL it was constructed at into history and the app", () => {
    withNavigation(
      "http://common.test/my-space/demo",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        expect(recorded.replace).toEqual([{
          state: { spaceName: "my-space", pieceSlug: "demo" },
          url: "/my-space/demo",
        }]);
        expect(recorded.push).toEqual([]);
        expect(recorded.views).toEqual([{
          spaceName: "my-space",
          pieceSlug: "demo",
        }]);
      },
    );
  });

  it("pushes a history entry for a cf-navigate event", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", {
            detail: { spaceName: "other", pieceId: "fid1:abc" },
          }),
        );
        expect(recorded.push).toEqual([{
          state: { spaceName: "other", pieceId: "fid1:abc" },
          url: "/other/fid1:abc",
        }]);
        expect(recorded.views.at(-1)).toEqual({
          spaceName: "other",
          pieceId: "fid1:abc",
        });
      },
    );
  });

  it("replaces the current entry for a cf-replace-navigation event", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-replace-navigation", {
            detail: { spaceName: "other" },
          }),
        );
        expect(recorded.push).toEqual([]);
        // The first is the construction-time reflection of the URL.
        expect(recorded.replace.at(-1)).toEqual({
          state: { spaceName: "other" },
          url: "/other",
        });
      },
    );
  });

  it("names the space it is already in rather than its DID", () => {
    withNavigation(
      "http://common.test/my-space",
      { view: { spaceName: "my-space" }, runtimeSpace: SPACE_DID as DID },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", {
            detail: { spaceDid: SPACE_DID, pieceId: "fid1:abc" },
          }),
        );
        expect(recorded.push.at(-1)).toEqual({
          state: { pieceId: "fid1:abc", spaceName: "my-space" },
          url: "/my-space/fid1:abc",
        });
      },
    );
  });

  it("keeps the member when it names the space rather than its DID", () => {
    withNavigation(
      "http://common.test/my-space",
      { view: { spaceName: "my-space" }, runtimeSpace: SPACE_DID as DID },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", {
            detail: {
              spaceDid: SPACE_DID,
              pieceSlug: "top",
              pieceMember: "42",
            },
          }),
        );
        expect(recorded.push.at(-1)).toEqual({
          state: {
            pieceSlug: "top",
            pieceMember: "42",
            spaceName: "my-space",
          },
          url: "/my-space/top/42",
        });
      },
    );
  });

  it("keeps a DID that names a space other than the running one", () => {
    const otherDid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    withNavigation(
      "http://common.test/my-space",
      { view: { spaceName: "my-space" }, runtimeSpace: SPACE_DID as DID },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", {
            detail: { spaceDid: otherDid, pieceId: "fid1:abc" },
          }),
        );
        expect(recorded.push.at(-1)).toEqual({
          state: { spaceDid: otherDid, pieceId: "fid1:abc" },
          url: `/${otherDid}/fid1:abc`,
        });
      },
    );
  });

  it("carries embed mode into a navigation that does not name it", () => {
    withNavigation(
      "http://common.test/.embed/my-space/demo",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", {
            detail: { spaceName: "other", pieceId: "fid1:abc" },
          }),
        );
        expect(recorded.push.at(-1)).toEqual({
          state: { spaceName: "other", pieceId: "fid1:abc", mode: "embed" },
          url: "/.embed/other/fid1:abc",
        });
      },
    );
  });

  it("sets the page title for a cf-update-page-title event", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        globalThis.dispatchEvent(
          new CustomEvent("cf-update-page-title", { detail: "My Profile" }),
        );
        expect(recorded.title()).toBe("My Profile");
      },
    );
  });

  it("applies the state a popstate carries without touching history", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        const before = recorded.replace.length;
        globalThis.dispatchEvent(
          Object.assign(new Event("popstate"), {
            state: { spaceName: "restored" },
          }),
        );
        expect(recorded.views.at(-1)).toEqual({ spaceName: "restored" });
        expect(recorded.push).toEqual([]);
        expect(recorded.replace.length).toBe(before);
      },
    );
  });

  it("ignores a popstate that carries no state", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (_navigation, recorded) => {
        const applied = recorded.views.length;
        globalThis.dispatchEvent(
          Object.assign(new Event("popstate"), { state: null }),
        );
        expect(recorded.views.length).toBe(applied);
      },
    );
  });

  it("stops responding to navigation events once disposed", () => {
    withNavigation(
      "http://common.test/",
      { view: { builtin: "home" } },
      (navigation, recorded) => {
        navigation.dispose();
        globalThis.dispatchEvent(
          new CustomEvent("cf-navigate", { detail: { spaceName: "other" } }),
        );
        expect(recorded.push).toEqual([]);
      },
    );
  });
});
