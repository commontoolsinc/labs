import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFCodeEditor, MimeType } from "./index.ts";

describe("CFCodeEditor", () => {
  it("should create element instance", () => {
    const element = new CFCodeEditor();
    expect(element).toBeInstanceOf(CFCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CFCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
    expect(element.autofocus).toBe(false);
    expect(element.cursorPosition).toBe("start");
    // No reference map, so mentions are minted as wiki-links.
    expect(element.references).toBe(null);
  });

  it("should have MimeType constants", () => {
    expect(MimeType.javascript).toBe("text/javascript");
    expect(MimeType.typescript).toBe("text/x.typescript");
    expect(MimeType.markdown).toBe("text/markdown");
    expect(MimeType.json).toBe("application/json");
    expect(MimeType.css).toBe("text/css");
    expect(MimeType.html).toBe("text/html");
    expect(MimeType.jsx).toBe("text/x.jsx");
  });

  it("should allow setting properties", () => {
    const element = new CFCodeEditor();
    element.value = "const x = 42;";
    element.language = MimeType.javascript;
    element.readonly = true;
    element.timingStrategy = "immediate";
    element.timingDelay = 100;

    expect(element.value).toBe("const x = 42;");
    expect(element.language).toBe(MimeType.javascript);
    expect(element.readonly).toBe(true);
    expect(element.timingStrategy).toBe("immediate");
    expect(element.timingDelay).toBe(100);
  });

  it("should allow setting autofocus and cursorPosition", () => {
    const element = new CFCodeEditor();
    element.autofocus = true;
    element.cursorPosition = "end";

    expect(element.autofocus).toBe(true);
    expect(element.cursorPosition).toBe("end");
  });

  it("should focus the editor when autofocus becomes true", () => {
    const element = new CFCodeEditor();
    let focused = false;
    (element as any)._editorView = {
      focus: () => {
        focused = true;
      },
    };

    element.autofocus = true;
    (element as any).updated(new Map([["autofocus", false]]));

    expect(focused).toBe(true);
  });
});

describe("CFCodeEditor backlink disposal handling", () => {
  // createBacklinkFromPattern issues an IPC createPage during a [[mention]]
  // gesture. On a disposal race (logout, runtime swap) that rejects with the
  // standard AbortError; the catch must treat it as cancellation, not log it.
  // Exercised against a minimal `this` so no CodeMirror/DOM is constructed.

  function captureConsoleError(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  function editorThis(aborted: boolean): Record<string, unknown> {
    return {
      // The ambient @consume runtime is cleared on logout; the guard must read
      // the pattern's own runtime instead, so leave this undefined.
      runtime: undefined,
      pattern: {
        runtime: () => ({
          signal: { aborted },
          createPage: () =>
            Promise.reject(new DOMException("aborted", "AbortError")),
        }),
        get: () => "{}",
        space: () => "did:key:mock",
      },
      _editorView: undefined,
      emit: () => {},
    };
  }

  function createBacklink(fakeThis: Record<string, unknown>): Promise<void> {
    const handler = (CFCodeEditor.prototype as unknown as {
      createBacklinkFromPattern(
        this: unknown,
        text: string,
        navigate: boolean,
      ): Promise<void>;
    }).createBacklinkFromPattern;
    return handler.call(fakeThis, "a note", true);
  }

  it("logs a backlink-create failure while the runtime is alive", async () => {
    const spy = captureConsoleError();
    try {
      await createBacklink(editorThis(false));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses backlink-create logging when the runtime is disposed", async () => {
    const spy = captureConsoleError();
    try {
      await createBacklink(editorThis(true));
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});

describe("CFCodeEditor reference-map housekeeping", () => {
  // The map lives beside the document and has to stay in step with it. Both
  // behaviors below are about NOT losing something: a key another editor
  // minted, and a deletion still sitting in the debounce. Exercised against a
  // minimal `this`, so no CodeMirror or DOM is constructed.

  const KEY = "a3f9zz";
  const OTHER = "b7k2m1";

  function editorThis(doc: string, map: Record<string, unknown>) {
    const deleted: string[] = [];
    let flushed = 0;
    return {
      deleted,
      flushes: () => flushed,
      self: {
        _editorView: { state: { doc: { toString: () => doc } } },
        references: {
          get: () => map,
          key: (k: string) => ({
            set: (v: unknown) => {
              if (v === undefined) deleted.push(k);
            },
          }),
        },
        _refKeysAtLoad: new Set<string>(),
        _cellController: { flush: () => flushed++ },
        _refMap() {
          return map;
        },
      } as Record<string, unknown>,
    };
  }

  function call(name: string, self: unknown, ...args: unknown[]): unknown {
    const fn = (CFCodeEditor.prototype as unknown as Record<
      string,
      (this: unknown, ...a: unknown[]) => unknown
    >)[name];
    return fn.call(self, ...args);
  }

  describe("_takenRefKeys()", () => {
    it("returns the map's keys and the document's together", () => {
      // A key pasted into the text is spoken for even before the map has it,
      // and minting over it would point two mentions at one entry.
      const { self } = editorThis(`[A][${OTHER}]`, { [KEY]: {} });
      expect(call("_takenRefKeys", self)).toEqual(new Set([KEY, OTHER]));
    });
  });

  describe("_collectUnreferencedRefEntries()", () => {
    it("removes an entry whose token has left the document", () => {
      const t = editorThis("no tokens left", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([KEY]);
    });

    it("keeps a key it never saw at load", () => {
      // Another editor added it while this one was open; this editor has no
      // reason to believe it was ever in its document.
      const t = editorThis("no tokens left", { [KEY]: {} });
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("keeps every entry while the token is still there", () => {
      const t = editorThis(`[A][${KEY}]`, { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("collects nothing against a document that has not loaded", () => {
      // An empty document names nothing, which is not the same as a document
      // that names nothing — reading it as the latter empties the map.
      const t = editorThis("", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.deleted).toEqual([]);
    });

    it("flushes the pending document write before removing anything", () => {
      // The deletion that made the entry collectable is still in the
      // debounce; losing it after the entry is gone leaves a token with no
      // destination in the durable document.
      const t = editorThis("no tokens left", { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.flushes()).toBe(1);
    });

    it("does not flush when there is nothing to collect", () => {
      const t = editorThis(`[A][${KEY}]`, { [KEY]: {} });
      (t.self._refKeysAtLoad as Set<string>).add(KEY);
      call("_collectUnreferencedRefEntries", t.self);
      expect(t.flushes()).toBe(0);
    });
  });
});
