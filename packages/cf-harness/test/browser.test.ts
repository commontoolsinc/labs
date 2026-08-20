import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type BrowserToolInput,
  planBrowserAction,
} from "../src/tools/browser.ts";

const argvOf = (input: BrowserToolInput): readonly string[] => {
  const plan = planBrowserAction(input);
  if (plan.error !== undefined) {
    throw new Error(`expected a plan, got error: ${plan.error}`);
  }
  return plan.argv;
};

const errorOf = (input: BrowserToolInput): string => {
  const plan = planBrowserAction(input);
  if (plan.error === undefined) {
    throw new Error(`expected an error, got argv: ${plan.argv.join(" ")}`);
  }
  return plan.error;
};

describe("browser", () => {
  describe("planBrowserAction", () => {
    it("refuses an action outside the vocabulary", () => {
      expect(errorOf({ action: "eval" })).toContain("action must be one of");
      expect(errorOf({})).toContain("action must be one of");
    });

    it("refuses a field that does not belong to the action", () => {
      expect(errorOf({ action: "snapshot", url: "https://example.com/" }))
        .toBe("url does not apply to the snapshot action");
      expect(errorOf({ action: "open", url: "https://a.example/", ref: "@e1" }))
        .toBe("ref does not apply to the open action");
      expect(errorOf({ action: "press", key: "Enter", value: "x" }))
        .toBe("value does not apply to the press action");
    });

    it("plans open for an http(s) URL only", () => {
      expect(argvOf({ action: "open", url: "https://example.com/a?b=c" }))
        .toEqual(["open", "https://example.com/a?b=c"]);
      expect(argvOf({ action: "open", url: "HTTP://example.com/" }))
        .toEqual(["open", "HTTP://example.com/"]);
      expect(errorOf({ action: "open" })).toBe("open requires a url");
      expect(errorOf({ action: "open", url: "file:///etc/passwd" }))
        .toBe("open only allows http(s) URLs");
      expect(errorOf({ action: "open", url: "javascript:alert(1)" }))
        .toBe("open only allows http(s) URLs");
    });

    it("plans snapshot with and without interactive refs", () => {
      expect(argvOf({ action: "snapshot" })).toEqual(["snapshot"]);
      expect(argvOf({ action: "snapshot", interactive: true }))
        .toEqual(["snapshot", "-i"]);
      expect(argvOf({ action: "snapshot", interactive: false }))
        .toEqual(["snapshot"]);
    });

    it("plans get for title, url, and targeted text", () => {
      expect(argvOf({ action: "get", kind: "title" })).toEqual([
        "get",
        "title",
      ]);
      expect(argvOf({ action: "get", kind: "url" })).toEqual(["get", "url"]);
      expect(argvOf({ action: "get", kind: "text", target: "h1" }))
        .toEqual(["get", "text", "h1"]);
      expect(errorOf({ action: "get", kind: "title", target: "h1" }))
        .toBe("get title does not take a target");
      expect(errorOf({ action: "get", kind: "text" }))
        .toBe("get text requires a target");
      expect(errorOf({ action: "get" }))
        .toBe("get requires kind title, url, or text");
      expect(errorOf({ action: "get", kind: "html" }))
        .toBe("get requires kind title, url, or text");
    });

    it("plans console and errors with no arguments", () => {
      expect(argvOf({ action: "console" })).toEqual(["console"]);
      expect(argvOf({ action: "errors" })).toEqual(["errors"]);
    });

    it("plans wait for exactly one of its four forms", () => {
      expect(argvOf({ action: "wait", ms: 500 })).toEqual(["wait", "500"]);
      expect(argvOf({ action: "wait", ref: "@e3" })).toEqual(["wait", "@e3"]);
      expect(argvOf({ action: "wait", loadState: "networkidle" }))
        .toEqual(["wait", "--load", "networkidle"]);
      expect(argvOf({ action: "wait", urlPattern: "**/checkout" }))
        .toEqual(["wait", "--url", "**/checkout"]);
      expect(errorOf({ action: "wait" }))
        .toBe("wait requires exactly one of ms, ref, loadState, or urlPattern");
      expect(errorOf({ action: "wait", ms: 500, ref: "@e3" }))
        .toBe("wait requires exactly one of ms, ref, loadState, or urlPattern");
    });

    it("bounds wait milliseconds and rejects non-integers", () => {
      expect(argvOf({ action: "wait", ms: 0 })).toEqual(["wait", "0"]);
      expect(argvOf({ action: "wait", ms: 30_000 })).toEqual([
        "wait",
        "30000",
      ]);
      expect(errorOf({ action: "wait", ms: 30_001 }))
        .toContain("between 0 and 30000");
      expect(errorOf({ action: "wait", ms: -1 }))
        .toContain("between 0 and 30000");
      expect(errorOf({ action: "wait", ms: 1.5 }))
        .toContain("between 0 and 30000");
    });

    it("rejects wait forms outside their own grammar", () => {
      expect(errorOf({ action: "wait", ref: "e3" }))
        .toContain("requires a ref starting with @");
      expect(errorOf({ action: "wait", loadState: "idle" }))
        .toBe("wait loadState must be domcontentloaded, load, or networkidle");
      expect(errorOf({ action: "wait", urlPattern: "" }))
        .toBe("wait urlPattern requires a non-file pattern");
      expect(errorOf({ action: "wait", urlPattern: "file:///tmp/x" }))
        .toBe("wait urlPattern requires a non-file pattern");
    });

    it("plans ref interactions and refuses targets that are not refs", () => {
      expect(argvOf({ action: "click", ref: "@e5" })).toEqual(["click", "@e5"]);
      expect(argvOf({ action: "check", ref: "@e6" })).toEqual(["check", "@e6"]);
      expect(errorOf({ action: "click", ref: "#submit" }))
        .toBe("click requires a ref starting with @, taken from a snapshot");
      expect(errorOf({ action: "check" }))
        .toBe("check requires a ref starting with @, taken from a snapshot");
    });

    it("plans fill, type, and select with a ref and a string value", () => {
      expect(argvOf({ action: "fill", ref: "@e2", value: "hello world" }))
        .toEqual(["fill", "@e2", "hello world"]);
      expect(argvOf({ action: "type", ref: "@e2", value: "" }))
        .toEqual(["type", "@e2", ""]);
      expect(argvOf({ action: "select", ref: "@e4", value: "option-2" }))
        .toEqual(["select", "@e4", "option-2"]);
      expect(errorOf({ action: "fill", ref: "@e2" }))
        .toBe("fill requires a string value");
      expect(errorOf({ action: "select", value: "option-2" }))
        .toBe("select requires a ref starting with @, taken from a snapshot");
    });

    it("plans press for one plain key and refuses anything else", () => {
      expect(argvOf({ action: "press", key: "Enter" })).toEqual([
        "press",
        "Enter",
      ]);
      expect(argvOf({ action: "press", key: "Control+a" })).toEqual([
        "press",
        "Control+a",
      ]);
      expect(errorOf({ action: "press" }))
        .toBe("press requires one key of letters, digits, _, +, ., or -");
      expect(errorOf({ action: "press", key: "Enter; rm -rf /" }))
        .toBe("press requires one key of letters, digits, _, +, ., or -");
    });
  });
});
