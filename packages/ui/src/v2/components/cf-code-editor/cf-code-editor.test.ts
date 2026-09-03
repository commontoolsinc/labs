import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  autocompletion,
  CompletionContext,
  type CompletionResult,
  completionStatus,
} from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { NAME } from "@commonfabric/runner/shared";
import { type CellHandle, type CellRef } from "@commonfabric/runtime-client";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import type { Mentionable, MentionableArray } from "../../core/mentionable.ts";
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
    expect(element.collaborative).toBe(false);
    // No reference map, so mentions are minted as wiki-links.
    expect(element.references).toBe(null);
    // No extra hosts; a pasted page URL is judged against this document's own.
    expect(element.fabricHosts).toEqual([]);
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
  // createBacklinkFromPattern issues an IPC createPiece during a [[mention]]
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
          createPiece: () =>
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

describe("CFCodeEditor pasted-mention decision", () => {
  // `_handleUrlPaste` decides whether a pasted URL becomes a mention, and it
  // prevents the browser's own paste when it does. Anything it declines has to
  // fall through UNPREVENTED, or the clipboard content goes nowhere — the
  // failure this pins. Exercised against a minimal `this`, so no CodeMirror or
  // DOM is constructed.

  const HASH = "V2tROHl4KsExx5M0fYnkQaOryFwjVUkqXIlcdMWz7SQ";
  const SPACE = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";

  // Built on the prototype so `_refMode` — a getter — and `_fabricHosts()`
  // resolve; the insertion itself needs a runtime, so an own property shadows
  // it. The decision under test needs neither.
  function pasteThis(): Record<string, unknown> {
    const own = (value: unknown) => ({ value, writable: true });
    // Defined rather than assigned: assigning would run Lit's reactive
    // property setters, which need instance state this object does not have.
    // Own data properties also shadow those accessors for the rest of the test.
    return Object.create(CFCodeEditor.prototype, {
      // Its presence is what selects reference mode.
      references: own({ get: () => ({}) }),
      pattern: own({ space: () => "did:key:mock" }),
      fabricHosts: own(["fabric.example"]),
      _editorView: own(undefined),
      _insertPastedMention: own(() => {}),
    });
  }

  function paste(
    fakeThis: Record<string, unknown>,
    text: string,
  ): { handled: boolean; prevented: boolean } {
    let prevented = false;
    const event = {
      clipboardData: { getData: () => text },
      preventDefault: () => (prevented = true),
    };
    const handled = (fakeThis as unknown as {
      _handleUrlPaste(event: unknown, view: unknown): boolean;
    })._handleUrlPaste(event, undefined);
    return { handled, prevented };
  }

  it("takes over a paste of a URL naming a piece", () => {
    const result = paste(pasteThis(), `/of:fid1:${HASH}`);
    expect(result.handled).toBe(true);
    expect(result.prevented).toBe(true);
  });

  it("takes over a paste of a page URL on a configured host", () => {
    const result = paste(
      pasteThis(),
      `https://fabric.example/${SPACE}/of:fid1:${HASH}`,
    );
    expect(result.handled).toBe(true);
  });

  it("leaves an ordinary web page to the browser, unprevented", () => {
    const result = paste(pasteThis(), "https://example.com/blog/post");
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves a slug URL to the browser, unprevented", () => {
    // A slug addresses a redirect document, which needs a read before it can
    // name a piece. Preventing the paste and then declining swallowed it.
    // The space is a DID on purpose: a named space is refused one check
    // earlier, so this would not reach the branch under test.

    const result = paste(
      pasteThis(),
      `https://fabric.example/${SPACE}/my-note`,
    );
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves a URL naming its space by name to the browser, unprevented", () => {
    const result = paste(
      pasteThis(),
      `https://fabric.example/work/of:fid1:${HASH}`,
    );
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves pasted prose alone", () => {
    const result = paste(pasteThis(), "some words and a space");
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });

  it("leaves every paste alone without a reference map", () => {
    const fakeThis = pasteThis();
    fakeThis.references = null;
    const result = paste(fakeThis, `/of:fid1:${HASH}`);
    expect(result.handled).toBe(false);
    expect(result.prevented).toBe(false);
  });
});

describe("CFCodeEditor mention-piece resolution", () => {
  // The private resolution surface under test. `piece`-bearing entries are
  // index rows standing for their piece; entries without one ARE the piece.
  // A row's piece is stored as a LINK, and its value crosses the client
  // boundary as an empty object — so the fixtures store raw `$link`
  // sigils, and the mock network's resolveAsCell follows them, exactly as
  // the runtime does. Nothing here reaches a piece through a value.
  type ResolutionInternals = {
    mentionable: CellHandle<MentionableArray> | null;
    mentioned?: CellHandle<MentionableArray>;
    pattern: CellHandle<string>;
    _editorView: EditorView | undefined;
    _resolvePieceIds(): Promise<void>;
    _resolvedPieceCells: Map<number, CellHandle<Mentionable>>;
    _backlinkCompletionAwaitingResolution: boolean;
    _getPieceId(index: number): string;
    findPieceById(id: string): CellHandle<Mentionable> | null;
    getFilteredMentionable(query: string): Array<[unknown, number]>;
    _completeBacklinkQuery(view: EditorView, text: string): void;
    createBacklinkCompletionSource(): (
      context: CompletionContext,
    ) => CompletionResult | null;
    willUpdate(changedProperties: Map<string, unknown>): void;
  };

  const internals = (element: CFCodeEditor): ResolutionInternals =>
    element as unknown as ResolutionInternals;

  const pieceLink = {
    "$link": { id: "of:target-piece", path: [] },
  };

  /** Creates the stateful part of an `EditorView` used by completion. */
  function createBacklinkView(
    source: (context: CompletionContext) => CompletionResult | null,
    doc: string,
    hasFocus = true,
  ) {
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [autocompletion({ override: [source] })],
    });
    return {
      state,
      hasFocus,
      dispatch(spec: TransactionSpec) {
        this.state = this.state.update(spec).state;
      },
    };
  }

  it("resolves a piece-bearing entry to its piece", async () => {
    const element = internals(new CFCodeEditor());
    const target = createMockCellHandle(
      { title: "Target" },
      { id: "of:target-piece" } as Partial<CellRef>,
    );
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;

    await element._resolvePieceIds();

    const resolved = element._resolvedPieceCells.get(0);
    expect(resolved?.id()).toBe(target.id());
  });

  it("resolves an entry without a piece to the entry itself", async () => {
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([{ [NAME]: "Direct" }]);
    element.mentionable = list as unknown as CellHandle<MentionableArray>;

    await element._resolvePieceIds();

    const resolved = element._resolvedPieceCells.get(0);
    expect(resolved?.id()).toBe(list.key(0).id());
  });

  it("withholds an index row until its piece resolves", async () => {
    // Before resolution a row has no usable identity — its sub-cell names
    // the row, and no id beats a wrong one — so the completion surfaces
    // exclude it and its id is empty. Resolution restores all three.
    const element = internals(new CFCodeEditor());
    const target = createMockCellHandle(
      { title: "Target" },
      { id: "of:target-piece" } as Partial<CellRef>,
    );
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;

    expect(element.getFilteredMentionable("")).toEqual([]);
    expect(element._getPieceId(0)).toBe("");

    await element._resolvePieceIds();

    expect(element.getFilteredMentionable("").length).toBe(1);
    const found = element.findPieceById(element._getPieceId(0));
    expect(found?.id()).toBe(target.id());
  });

  it("defers `$mentioned` reconciliation until index rows resolve", async () => {
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]);
    const release = Promise.withResolvers<void>();
    const realKey = list.key.bind(list);
    list.key = ((key: PropertyKey) => {
      const row = realKey(key as never);
      if (String(key) === "0") {
        const realRowKey = row.key.bind(row);
        row.key = ((rowKey: PropertyKey) => {
          const destination = realRowKey(rowKey as never);
          if (String(rowKey) === "piece") {
            const realResolve = destination.resolveAsCell.bind(destination);
            destination.resolveAsCell = (async () => {
              await release.promise;
              return await realResolve();
            }) as typeof destination.resolveAsCell;
          }
          return destination;
        }) as unknown as typeof row.key;
      }
      return row;
    }) as typeof list.key;
    Object.defineProperty(list, "asSchema", { value: () => list });

    const mentioned = createMockCellHandle<MentionableArray>([], {
      id: "of:mentioned" as CellRef["id"],
    });
    let writes = 0;
    let written: MentionableArray | undefined;
    const realSet = mentioned.set.bind(mentioned);
    Object.defineProperty(mentioned, "set", {
      value: (value: MentionableArray) => {
        writes++;
        written = value;
        return realSet(value);
      },
    });
    element.mentionable = list as unknown as CellHandle<MentionableArray>;
    element.mentioned = mentioned;
    Object.defineProperty(element, "getValue", {
      value: () => "[[Row (target-piece)]]",
    });
    const resolutions: Promise<void>[] = [];
    const resolvePieceIds = element._resolvePieceIds.bind(element);
    Object.defineProperty(element, "_resolvePieceIds", {
      value: () => {
        const resolution = resolvePieceIds();
        resolutions.push(resolution);
        return resolution;
      },
    });

    element.willUpdate(new Map([["mentionable", null]]));
    expect(writes).toBe(0);

    release.resolve();
    await Promise.all(resolutions);

    expect(writes).toBe(1);
    expect((written?.[0] as unknown as CellHandle<Mentionable>).id()).toBe(
      "of:target-piece",
    );
  });

  it("does not create a piece for an exact unresolved index row", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Existing Topic", title: "Existing Topic", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    element.pattern = createMockCellHandle("pattern");
    let creations = 0;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: () => {
        creations++;
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Existing Topic");
    element._editorView = view as unknown as EditorView;

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "Existing Topic",
    );

    expect(creations).toBe(0);
    expect(view.state.doc.toString()).toBe("[[Existing Topic");
    expect(element._backlinkCompletionAwaitingResolution).toBe(true);
    await element._resolvePieceIds();
  });

  it("creates a piece when no exact row is present", () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle<MentionableArray>([]);
    element.pattern = createMockCellHandle("pattern");
    let creation: [string, boolean] | undefined;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: (text: string, navigate: boolean) => {
        creation = [text, navigate];
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[New Topic");

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "New Topic",
    );

    expect(creation).toEqual(["New Topic", false]);
    expect(view.state.doc.toString()).toBe("[[New Topic]]");
  });

  it("creates a piece when an unresolved row is not an exact match", () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Existing Topic", title: "Existing Topic", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    element.pattern = createMockCellHandle("pattern");
    let creation: [string, boolean] | undefined;
    Object.defineProperty(element, "createBacklinkFromPattern", {
      value: (text: string, navigate: boolean) => {
        creation = [text, navigate];
        return Promise.resolve();
      },
    });
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Top");

    element._completeBacklinkQuery(
      view as unknown as EditorView,
      "Top",
    );

    expect(creation).toEqual(["Top", false]);
    expect(view.state.doc.toString()).toBe("[[Top]]");
  });

  it("restarts a matching backlink completion after resolution", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Ro");
    element._editorView = view as unknown as EditorView;

    const initial = source(new CompletionContext(view.state, 4, true));
    expect(initial?.options).toEqual([]);
    expect(completionStatus(view.state)).toBe(null);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe("pending");
    const refreshed = source(new CompletionContext(view.state, 4, true));
    expect(refreshed?.options.length).toBe(1);
  });

  it("does not restart a backlink completion after focus leaves", async () => {
    const element = internals(new CFCodeEditor());
    element.mentionable = createMockCellHandle([
      { [NAME]: "Row", title: "Row", piece: pieceLink },
    ]) as unknown as CellHandle<MentionableArray>;
    const source = element.createBacklinkCompletionSource();
    const view = createBacklinkView(source, "[[Ro", false);
    element._editorView = view as unknown as EditorView;

    const initial = source(new CompletionContext(view.state, 4, true));
    expect(initial?.options).toEqual([]);

    await element._resolvePieceIds();

    expect(completionStatus(view.state)).toBe(null);
  });

  it("keeps the newer resolution when an older pass finishes late", async () => {
    // The mentionable HANDLE stays identical when its contents change, so an
    // older pass that resolves slowly can finish after a newer one. The
    // slow pass is gated open only once the fast pass has published; what
    // the caches hold at the end decides the race. Plain entries, so the
    // gate can ride the sub-cell the pass resolves.
    const element = internals(new CFCodeEditor());
    const list = createMockCellHandle([{ [NAME]: "Slow" }], {
      id: "of:race-list" as CellRef["id"],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    const realKey = list.key.bind(list);
    list.key = ((k: PropertyKey) => {
      const child = realKey(k as never);
      if (armed && String(k) === "0") {
        const realResolve = child.resolveAsCell.bind(child);
        child.resolveAsCell = (async () => {
          await gate;
          return await realResolve();
        }) as typeof child.resolveAsCell;
      }
      return child;
    }) as typeof list.key;

    element.mentionable = list as unknown as CellHandle<MentionableArray>;
    const older = element._resolvePieceIds();

    armed = false;
    list.set([{ [NAME]: "Fast" }]);
    await element._resolvePieceIds();
    const fastId = element._resolvedPieceCells.get(0)?.id();
    expect(fastId).toBeDefined();

    release();
    await older;
    expect(element._resolvedPieceCells.get(0)?.id()).toBe(fastId);
  });
});
