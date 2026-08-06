import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { GlobalShortcutsController } from "../src/lib/global-shortcuts-controller.ts";
import type { Command } from "../shared/mod.ts";

// Exercises the shell's two global keyboard shortcuts: Cmd/Ctrl+Shift+O opens
// the quick jump view, and Alt+W navigates to the space the current view
// addresses. Both go through a single document keydown listener, so the tests
// drive that listener directly with synthetic events.

// The controller reads `navigator.platform` and attaches to `document`, and
// `navigate` dispatches on `globalThis`. Deno has none of those shaped the way
// a browser does, so stand in for them around each test and restore after.
function withStubbedEnv<T>(
  platform: string,
  run: (env: {
    dispatch: (
      init: Partial<Omit<KeyboardEventLike, "composedPath">>,
    ) => KeyboardEventLike;
    commands: Command[];
    navigations: unknown[];
    disconnect: () => void;
  }) => T,
  view: unknown = { spaceName: "my-space" },
): T {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  let listener: ((e: KeyboardEventLike) => void) | undefined;
  setGlobal("navigator", { platform });
  setGlobal("document", {
    addEventListener(type: string, fn: (e: KeyboardEventLike) => void) {
      if (type === "keydown") listener = fn;
    },
    removeEventListener(type: string) {
      if (type === "keydown") listener = undefined;
    },
  });

  const commands: Command[] = [];
  const navigations: unknown[] = [];
  const onNavigate = (e: Event) => {
    navigations.push((e as CustomEvent).detail);
  };
  globalThis.addEventListener("cf-navigate", onNavigate);

  const controller = new GlobalShortcutsController(
    makeHost(commands, view) as never,
  );
  controller.hostConnected();

  try {
    return run({
      dispatch: (init) => {
        const event = makeEvent(init);
        listener?.(event);
        return event;
      },
      commands,
      navigations,
      disconnect: () => {
        controller.hostDisconnected();
        expect(listener).toBeUndefined();
      },
    });
  } finally {
    globalThis.removeEventListener("cf-navigate", onNavigate);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      // deno-lint-ignore no-explicit-any
      else delete (globalThis as any)[name];
    }
  }
}

// The slice of the host the controller touches: it registers itself, dispatches
// shell commands, and reads the current view off the app state.
function makeHost(commands: Command[], view: unknown) {
  return {
    addController() {},
    command(command: Command) {
      commands.push(command);
    },
    app: { view },
  };
}

// The slice of KeyboardEvent the controller reads, plus a `preventDefault` that
// records the call the way the real event does. `path` stands in for the
// composed path, innermost node first, and ends in the two non-element nodes a
// real path ends in.
interface KeyboardEventLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  path: unknown[];
  composedPath(): unknown[];
  preventDefault(): void;
}

function makeEvent(
  init: Partial<Omit<KeyboardEventLike, "composedPath">>,
): KeyboardEventLike {
  const event: KeyboardEventLike = {
    code: "KeyA",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    path: [],
    composedPath: () => [...event.path, { nodeType: 9 }, {}],
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...init,
  };
  return event;
}

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

describe("GlobalShortcutsController", () => {
  it("opens quick jump on Cmd+Shift+O on a Mac", () => {
    withStubbedEnv(MAC, ({ dispatch, commands }) => {
      const event = dispatch({ code: "KeyO", metaKey: true, shiftKey: true });
      expect(commands).toEqual([
        { type: "set-config", key: "showQuickJumpView", value: true },
      ]);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it("opens quick jump on Ctrl+Shift+O off a Mac", () => {
    withStubbedEnv(LINUX, ({ dispatch, commands }) => {
      dispatch({ code: "KeyO", ctrlKey: true, shiftKey: true });
      expect(commands).toEqual([
        { type: "set-config", key: "showQuickJumpView", value: true },
      ]);
    });
  });

  it("uses only the platform's own modifier for quick jump", () => {
    withStubbedEnv(MAC, ({ dispatch, commands }) => {
      dispatch({ code: "KeyO", ctrlKey: true, shiftKey: true });
      expect(commands).toEqual([]);
    });
    withStubbedEnv(LINUX, ({ dispatch, commands }) => {
      dispatch({ code: "KeyO", metaKey: true, shiftKey: true });
      expect(commands).toEqual([]);
    });
  });

  it("ignores quick jump without shift, and with extra modifiers", () => {
    withStubbedEnv(MAC, ({ dispatch, commands }) => {
      dispatch({ code: "KeyO", metaKey: true });
      dispatch({
        code: "KeyO",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      });
      dispatch({
        code: "KeyO",
        metaKey: true,
        shiftKey: true,
        ctrlKey: true,
      });
      expect(commands).toEqual([]);
    });
  });

  it("navigates to the current space on Alt+W", () => {
    withStubbedEnv(MAC, ({ dispatch, navigations }) => {
      const event = dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([{ spaceName: "my-space" }]);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it("ignores Alt+W carrying any other modifier", () => {
    withStubbedEnv(MAC, ({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true, shiftKey: true });
      dispatch({ code: "KeyW", altKey: true, metaKey: true });
      dispatch({ code: "KeyW", altKey: true, ctrlKey: true });
      dispatch({ code: "KeyW" });
      expect(navigations).toEqual([]);
    });
  });

  it("skips shortcuts aimed at a text-entry element", () => {
    for (
      const target of [
        { tagName: "INPUT" },
        { tagName: "TEXTAREA" },
        { tagName: "SELECT" },
        { tagName: "DIV", isContentEditable: true },
      ]
    ) {
      withStubbedEnv(MAC, ({ dispatch, commands, navigations }) => {
        const path = [target, { tagName: "BODY" }];
        dispatch({ code: "KeyO", metaKey: true, shiftKey: true, path });
        dispatch({ code: "KeyW", altKey: true, path });
        expect(commands).toEqual([]);
        expect(navigations).toEqual([]);
      });
    }
  });

  it("skips a text-entry element inside a shadow root", () => {
    withStubbedEnv(MAC, ({ dispatch, commands, navigations }) => {
      // A keydown that crosses a shadow boundary reports the host as its
      // target, so only the composed path still names the input.
      const path = [
        { tagName: "INPUT" },
        { tagName: "X-QUICK-JUMP-VIEW" },
        { tagName: "BODY" },
      ];
      dispatch({ code: "KeyO", metaKey: true, shiftKey: true, path });
      dispatch({ code: "KeyW", altKey: true, path });
      expect(commands).toEqual([]);
      expect(navigations).toEqual([]);
    });
  });

  it("still fires for a plain element target", () => {
    withStubbedEnv(MAC, ({ dispatch, commands }) => {
      dispatch({
        code: "KeyO",
        metaKey: true,
        shiftKey: true,
        path: [
          { tagName: "DIV", isContentEditable: false },
          { tagName: "X-APP-VIEW" },
          { tagName: "BODY" },
        ],
      });
      expect(commands).toHaveLength(1);
    });
  });

  it("skips auto-repeat and events something else already handled", () => {
    withStubbedEnv(MAC, ({ dispatch, commands, navigations }) => {
      dispatch({ code: "KeyO", metaKey: true, shiftKey: true, repeat: true });
      dispatch({
        code: "KeyO",
        metaKey: true,
        shiftKey: true,
        defaultPrevented: true,
      });
      dispatch({ code: "KeyW", altKey: true, repeat: true });
      expect(commands).toEqual([]);
      expect(navigations).toEqual([]);
    });
  });

  it("falls back to the common knowledge space when the view names none", () => {
    withStubbedEnv(MAC, ({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([{ spaceName: "common-knowledge" }]);
    }, { spaceDid: "did:key:zSpaceX" });
  });

  it("stops listening once the host disconnects", () => {
    withStubbedEnv(MAC, ({ dispatch, commands, disconnect }) => {
      disconnect();
      dispatch({ code: "KeyO", metaKey: true, shiftKey: true });
      expect(commands).toEqual([]);
    });
  });
});
