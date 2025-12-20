/**
 * Tests for CTFileDownload component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTFileDownload } from "./ct-file-download.ts";

describe("CTFileDownload", () => {
  it("should be defined", () => {
    expect(CTFileDownload).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-file-download")).toBe(CTFileDownload);
  });

  it("should create element instance", () => {
    const element = new CTFileDownload();
    expect(element).toBeInstanceOf(CTFileDownload);
  });

  it("should have default properties", () => {
    const element = new CTFileDownload();
    expect(element.data).toBe("");
    expect(element.filename).toBe("");
    expect(element.mimeType).toBe("text/plain");
    expect(element.base64).toBe(false);
    expect(element.variant).toBe("secondary");
    expect(element.size).toBe("default");
    expect(element.disabled).toBe(false);
    expect(element.feedbackDuration).toBe(2000);
    expect(element.iconOnly).toBe(false);
  });
});
