import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getIframeContextHandler,
  type IframeContextHandler,
  setIframeContextHandler,
} from "../src/context.ts";

const HANDLER = {
  read: () => undefined,
  write: () => {},
  subscribe: () => 0,
  unsubscribe: () => {},
} as unknown as IframeContextHandler;

describe("context", () => {
  it("returns the handler that was set", () => {
    setIframeContextHandler(HANDLER);
    expect(getIframeContextHandler()).toBe(HANDLER);
  });

  it("returns the later handler when one replaces another", () => {
    const replacement = { ...HANDLER } as IframeContextHandler;
    setIframeContextHandler(HANDLER);
    setIframeContextHandler(replacement);
    expect(getIframeContextHandler()).toBe(replacement);
  });
});
