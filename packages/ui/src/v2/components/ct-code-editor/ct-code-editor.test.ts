import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTCodeEditor, MimeType } from "./ct-code-editor.ts";

describe("CTCodeEditor", () => {
  it("should be defined", () => {
    expect(CTCodeEditor).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTCodeEditor.name).toBe("CTCodeEditor");
  });

  it("should create element instance", () => {
    const element = new CTCodeEditor();
    expect(element).toBeInstanceOf(CTCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CTCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
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
    const element = new CTCodeEditor();
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
});