import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  toSpaceWebSocketAddress,
  toWebSocketAddress,
} from "../src/storage/v2-remote-session.ts";

describe("memory v2 remote session websocket address", () => {
  it("upgrades http and https urls to websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("http://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("https://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("preserves existing websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("ws://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("wss://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("adds the memory space to the websocket query", () => {
    expect(
      toSpaceWebSocketAddress(
        new URL("https://example.test/api/storage/memory?trace=1"),
        "did:key:z6Mk-storage-space",
      ).toString(),
    ).toBe(
      "wss://example.test/api/storage/memory?trace=1&space=did%3Akey%3Az6Mk-storage-space",
    );
  });
});
