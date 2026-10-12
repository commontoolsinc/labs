// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/home-bring-up";

/**
 * A runtime that answers the space's root with a piece, and records in `log`,
 * under `name`, each request to idle and each to bring Home up. `ensured`
 * resolves at the first bring-up.
 */
function stubRuntime(log: string[], name: string) {
  const ensured = defer();
  let ensures = 0;
  const client = {
    idle: () => {
      log.push(`${name} idle`);
      return Promise.resolve();
    },
    ensureHomePatternRunning: () => {
      log.push(`${name} ensure`);
      ensures++;
      ensured.resolve();
      return Promise.resolve({});
    },
  };
  const rt = {
    signal: new AbortController().signal,
    getSpaceRootPattern: () => Promise.resolve({ id: () => "root" }),
    runtime: () => client,
  };
  return {
    rt,
    ensured: ensured.promise,
    get ensures() {
      return ensures;
    },
  };
}

describe("XAppView Home bring-up", () => {
  it("asks its runtime to bring Home up after its first piece is on screen and the view has settled", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const runtime = stubRuntime(log, "rt");
      const view = new XAppView();
      view.app = {
        view: { spaceDid: "did:key:z6Mk-shell-home-bring-up" as DID },
      } as never;
      view.space = "did:key:z6Mk-shell-home-bring-up" as DID;
      view.rt = runtime.rt as never;

      // An update with no piece on screen yet.
      view.updated(new Map());

      log.push("shown");
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;
      view.updated(new Map());
      await runtime.ensured;

      expect(log).toEqual(["shown", "rt idle", "rt ensure"]);
    } finally {
      restore();
    }
  });

  it("asks each runtime to bring Home up once", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const log: string[] = [];
      const first = stubRuntime(log, "first");
      const second = stubRuntime(log, "second");
      const view = new XAppView();
      view.app = {
        view: { spaceDid: "did:key:z6Mk-shell-home-bring-up-twice" as DID },
      } as never;
      view.space = "did:key:z6Mk-shell-home-bring-up-twice" as DID;
      view.rt = first.rt as never;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._patterns.run();
      await view._patterns.taskComplete;

      view.updated(new Map());
      view.updated(new Map());
      await first.ensured;
      view.updated(new Map());

      // A replacement runtime is a worker of its own, so it is asked too. Any
      // second request to the first runtime would have been made by now.
      view.rt = second.rt as never;
      view.updated(new Map());
      await second.ensured;

      expect(first.ensures).toBe(1);
      expect(second.ensures).toBe(1);
    } finally {
      restore();
    }
  });
});
