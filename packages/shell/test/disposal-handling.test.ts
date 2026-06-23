import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { XFavoriteButtonElement } from "../src/components/FavoriteButton.ts";
import { XDebuggerView } from "../src/views/DebuggerView.ts";

// Shell components log when a runtime operation fails. When the failure is a
// disposal race (logout, runtime swap) the operation was cancelled, not a
// genuine failure, so the log is suppressed via `this.rt?.signal.aborted`.
//
// FavoriteButton's click handler is a prototype method, so it can be exercised
// against a minimal `this` without constructing a real custom element. BodyView
// carries the byte-identical guard in its `_handleCellPin` handler, but its
// module graph pulls in components that require a real DOM (`HTMLElement`,
// `window`) at load, which the headless runner lacks; that guard is covered by
// inspection and by the equivalent FavoriteButton case below.

function captureConsoleError(): { calls: unknown[][]; restore(): void } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  return { calls, restore: () => (console.error = original) };
}

function favoritesThatReject() {
  const reject = () =>
    Promise.reject(new DOMException("aborted", "AbortError"));
  return () => ({ addFavorite: reject, removeFavorite: reject });
}

function invokeToggle(fakeThis: Record<string, unknown>): Promise<void> {
  const handler = (XFavoriteButtonElement.prototype as unknown as {
    _handleFavoriteClick(this: unknown, e: Event): Promise<void>;
  })._handleFavoriteClick;
  return handler.call(fakeThis, new Event("click"));
}

describe("FavoriteButton disposal handling", () => {
  function fakeThis(aborted: boolean): Record<string, unknown> {
    return {
      rt: { signal: { aborted }, favorites: favoritesThatReject() },
      space: "did:key:mock" as DID,
      pieceId: "piece-1",
      spaceName: undefined,
      _isLoading: false,
      _localIsFavorite: undefined,
      _deriveIsFavorite: () => false,
    };
  }

  it("logs a toggle failure while the runtime is alive", async () => {
    const spy = captureConsoleError();
    try {
      await invokeToggle(fakeThis(false));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses toggle-failure logging when the runtime is disposed", async () => {
    const spy = captureConsoleError();
    try {
      await invokeToggle(fakeThis(true));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});

describe("DebuggerView worker-logger disposal handling", () => {
  // These handlers run fire-and-forget from @click; a disposal-raced rejection
  // must neither log nor escape as an unhandled rejection.
  function debuggerThis(
    aborted: boolean,
    rejecting: () => Promise<void>,
  ): Record<string, unknown> {
    const rt = {
      signal: { aborted },
      resetLoggerBaselines: rejecting,
      setLoggerEnabled: rejecting,
      setLoggerLevel: rejecting,
      getLoggerCounts: rejecting,
    };
    return {
      loggerBaseline: null,
      workerLoggerMetadata: { worker: { enabled: false } },
      getLoggerRegistry: () => ({}),
      debuggerController: { getRuntime: () => ({ runtime: () => rt }) },
      sampleLoggerCounts: () => Promise.resolve(),
    };
  }

  const reject = () =>
    Promise.reject(new DOMException("aborted", "AbortError"));

  function method(name: string) {
    return (XDebuggerView.prototype as unknown as Record<
      string,
      (this: unknown, ...args: unknown[]) => Promise<void>
    >)[name];
  }

  for (
    const [label, name, args] of [
      ["resetBaseline", "resetBaseline", []],
      ["toggleLogger", "toggleLogger", ["worker"]],
      ["setLoggerLevel", "setLoggerLevel", ["worker", "info"]],
    ] as Array<[string, string, unknown[]]>
  ) {
    it(`${label} logs a failure while the runtime is alive`, async () => {
      const spy = captureConsoleError();
      try {
        await method(name).call(debuggerThis(false, reject), ...args);
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(1);
    });

    it(`${label} stays silent when the runtime is disposed`, async () => {
      const spy = captureConsoleError();
      try {
        await method(name).call(debuggerThis(true, reject), ...args);
      } finally {
        spy.restore();
      }
      expect(spy.calls.length).toBe(0);
    });
  }
});
