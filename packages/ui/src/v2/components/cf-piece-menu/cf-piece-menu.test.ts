import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { pieceMenuEntries } from "./cf-piece-menu.ts";
import {
  describeOrigin,
  formatTimestamp,
  shortIdentity,
} from "./origin-view.ts";

// The menu's DOM behaviour (portalling onto document.body, positioning, opening
// a panel) needs a real DOM and is covered by the shell's integration test,
// which drives the menu through a real right-click. What is verifiable here is
// the part with no DOM in it: the entries the component contributes, and how a
// piece's recorded source facts read.

describe("piece menu entries", () => {
  it("offers exactly the two read actions, in order", () => {
    expect(pieceMenuEntries().map((entry) => entry.label)).toEqual([
      "View source",
      "Origin and history",
    ]);
  });

  it("gives each entry a stable hook a host's tests can select", () => {
    expect(pieceMenuEntries().map((entry) => entry.testId)).toEqual([
      "piece-menu-source",
      "piece-menu-origin",
    ]);
  });
});

describe("describeOrigin", () => {
  it("names the detached case without inventing an origin", () => {
    const description = describeOrigin(undefined);
    expect(description.label).toBe("Detached");
    expect(description.detail).toContain("no origin");
  });

  it("distinguishes a mutable piece origin from an exact pattern", () => {
    expect(
      describeOrigin({
        url: "cf:/did:key:z6Mk/of:fid1:x",
        kind: "fabric-piece",
      }).label,
    ).toBe("Fabric piece");
    expect(
      describeOrigin({ url: "cf:pattern:x", kind: "fabric-pattern" }).label,
    ).toBe("Exact pattern");
    expect(
      describeOrigin({ url: "https://example.test/p.tsx", kind: "web" }).label,
    ).toBe("External web URL");
  });

  it("says what each kind of origin can do", () => {
    expect(describeOrigin({ url: "https://e.test/p.tsx", kind: "web" }).detail)
      .toContain("can return new source later");
    expect(
      describeOrigin({ url: "cf:pattern:x", kind: "fabric-pattern" }).detail,
    ).toContain("always resolves to");
  });
});

describe("shortIdentity", () => {
  it("abbreviates a content identity but keeps short values whole", () => {
    expect(shortIdentity("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijkl…");
    expect(shortIdentity("abcdef")).toBe("abcdef");
  });
});

describe("formatTimestamp", () => {
  it("renders a recorded timestamp as local time", () => {
    const stamped = formatTimestamp(Date.UTC(2026, 6, 24, 12, 0, 0));
    expect(stamped).toContain("2026");
    expect(stamped.length).toBeGreaterThan(0);
  });
});
