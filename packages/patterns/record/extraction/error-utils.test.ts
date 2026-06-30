import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { getOcrErrorText } from "./error-utils.ts";

describe("getOcrErrorText", () => {
  it("preserves string errors", () => {
    expect(getOcrErrorText("OCR request failed")).toBe("OCR request failed");
  });

  it("returns undefined for missing errors", () => {
    expect(getOcrErrorText(undefined)).toBeUndefined();
    expect(getOcrErrorText(null)).toBeUndefined();
    expect(getOcrErrorText("")).toBeUndefined();
  });

  it("reads a legacy object message", () => {
    expect(getOcrErrorText({ message: "Vision model timed out" })).toBe(
      "Vision model timed out",
    );
  });

  it("reads Error messages", () => {
    expect(getOcrErrorText(new Error("Image was too large"))).toBe(
      "Image was too large",
    );
  });

  it("falls back to string conversion", () => {
    expect(getOcrErrorText({ code: "OCR_FAILED" })).toBe("[object Object]");
  });
});
