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
      runtime: { signal: { aborted } },
      pattern: {
        runtime: () => ({
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
