import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ReactiveControllerHost } from "lit";
import { NAME } from "@commontools/runner/shared";
import { createMockCellHandle } from "../test-utils/mock-cell-handle.ts";
import { MentionController } from "./mention-controller.ts";
import type { MentionableArray } from "./mentionable.ts";

/** Minimal KeyboardEvent stand-in for Deno (no DOM). */
function fakeKeyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent;
}

function createMockHost(): ReactiveControllerHost {
  return {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost;
}

/** Helper to create a mentionable cell with named items. */
function createMentionableCell(names: string[]) {
  const items: MentionableArray = names.map((n) => ({ [NAME]: n }));
  return createMockCellHandle(items, {
    id: "of:mentionables" as any,
    schema: { type: "array", items: { type: "object" } },
  });
}

// ---------------------------------------------------------------------------
// Trigger detection and query extraction
// ---------------------------------------------------------------------------

describe("MentionController — trigger detection", () => {
  it("shows mentions when @ is typed", () => {
    const content = "@";
    const cursor = 1;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });

    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(true);
    expect(ctrl.state.query).toBe("");
  });

  it("extracts query after @", () => {
    const content = "@ali";
    const cursor = 4;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });

    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(true);
    expect(ctrl.state.query).toBe("ali");
  });

  it("hides when space appears in query", () => {
    const content = "@ali ce";
    const cursor = 7;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });

    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(false);
  });

  it("hides when no trigger is present", () => {
    const content = "hello";
    const cursor = 5;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });

    // First show it
    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(false);
  });

  it("supports custom trigger character", () => {
    const content = "#";
    const cursor = 1;
    const ctrl = new MentionController(createMockHost(), {
      trigger: "#",
      getContent: () => content,
      getCursorPosition: () => cursor,
    });

    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("MentionController — filtering", () => {
  it("returns all items when query is empty", () => {
    const ctrl = new MentionController(createMockHost());
    const cell = createMentionableCell(["Alice", "Bob", "Charlie"]);
    ctrl.setMentionable(cell);

    const filtered = ctrl.getFilteredMentions();
    expect(filtered.length).toBe(3);
  });

  it("filters by name (case-insensitive)", () => {
    const content = "@al";
    const cursor = 3;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });
    const cell = createMentionableCell(["Alice", "Bob", "Alvin"]);
    ctrl.setMentionable(cell);

    ctrl.handleInput(new Event("input"));
    const filtered = ctrl.getFilteredMentions();
    expect(filtered.length).toBe(2);
    expect(filtered[0].get()?.[NAME]).toBe("Alice");
    expect(filtered[1].get()?.[NAME]).toBe("Alvin");
  });

  it("returns empty when no mentionable is set", () => {
    const ctrl = new MentionController(createMockHost());
    expect(ctrl.getFilteredMentions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

describe("MentionController — keyboard navigation", () => {
  function createShowingController() {
    const content = "@";
    const cursor = 1;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });
    const cell = createMentionableCell(["Alice", "Bob", "Charlie"]);
    ctrl.setMentionable(cell);
    ctrl.handleInput(new Event("input"));
    return ctrl;
  }

  it("ArrowDown increments selectedIndex", () => {
    const ctrl = createShowingController();
    expect(ctrl.state.selectedIndex).toBe(0);

    const event = fakeKeyEvent("ArrowDown");
    const handled = ctrl.handleKeyDown(event);
    expect(handled).toBe(true);
    expect(ctrl.state.selectedIndex).toBe(1);
  });

  it("ArrowDown clamps to max index", () => {
    const ctrl = createShowingController();
    ctrl.handleKeyDown(fakeKeyEvent("ArrowDown"));
    ctrl.handleKeyDown(fakeKeyEvent("ArrowDown"));
    ctrl.handleKeyDown(fakeKeyEvent("ArrowDown"));
    ctrl.handleKeyDown(fakeKeyEvent("ArrowDown"));
    expect(ctrl.state.selectedIndex).toBe(2); // clamped to length-1
  });

  it("ArrowUp decrements selectedIndex", () => {
    const ctrl = createShowingController();
    ctrl.handleKeyDown(fakeKeyEvent("ArrowDown"));
    ctrl.handleKeyDown(fakeKeyEvent("ArrowUp"));
    expect(ctrl.state.selectedIndex).toBe(0);
  });

  it("ArrowUp clamps to 0", () => {
    const ctrl = createShowingController();
    ctrl.handleKeyDown(fakeKeyEvent("ArrowUp"));
    expect(ctrl.state.selectedIndex).toBe(0);
  });

  it("Escape hides the dropdown", () => {
    const ctrl = createShowingController();
    ctrl.handleKeyDown(fakeKeyEvent("Escape"));
    expect(ctrl.isShowing).toBe(false);
  });

  it("Enter inserts the selected mention", () => {
    const inserts: string[] = [];
    const content = "@";
    const cursor = 1;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
      onInsert: (markdown) => inserts.push(markdown),
    });
    const cell = createMentionableCell(["Alice"]);
    ctrl.setMentionable(cell);
    ctrl.handleInput(new Event("input"));

    const handled = ctrl.handleKeyDown(
      fakeKeyEvent("Enter"),
    );
    expect(handled).toBe(true);
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toContain("[Alice]");
    expect(ctrl.isShowing).toBe(false);
  });

  it("returns false when not showing", () => {
    const ctrl = new MentionController(createMockHost());
    const handled = ctrl.handleKeyDown(
      fakeKeyEvent("ArrowDown"),
    );
    expect(handled).toBe(false);
  });

  it("Enter returns false when no matches exist", () => {
    const content = "@zzzzz";
    const cursor = 6;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });
    const cell = createMentionableCell(["Alice"]);
    ctrl.setMentionable(cell);
    ctrl.handleInput(new Event("input"));

    const handled = ctrl.handleKeyDown(
      fakeKeyEvent("Enter"),
    );
    expect(handled).toBe(false); // no match, don't intercept Enter
  });
});

// ---------------------------------------------------------------------------
// Mention insertion and encoding
// ---------------------------------------------------------------------------

describe("MentionController — mention insertion", () => {
  it("encodes mention as markdown link [name](encodedId)", () => {
    const inserts: string[] = [];
    const content = "@";
    const cursor = 1;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
      onInsert: (markdown) => inserts.push(markdown),
    });
    const cell = createMentionableCell(["Test Item"]);
    ctrl.setMentionable(cell);
    ctrl.handleInput(new Event("input"));

    const filtered = ctrl.getFilteredMentions();
    ctrl.insertMention(filtered[0]);

    expect(inserts.length).toBe(1);
    expect(inserts[0]).toMatch(/^\[Test Item\]\(.+\)$/);
    expect(ctrl.isShowing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractMentionsFromText
// ---------------------------------------------------------------------------

describe("MentionController — extractMentionsFromText", () => {
  it("extracts mentions from markdown links", () => {
    const ctrl = new MentionController(createMockHost());
    const cell = createMentionableCell(["Alice", "Bob"]);
    ctrl.setMentionable(cell);

    // Get the actual encoded IDs
    const allMentions = ctrl.getFilteredMentions();
    const aliceId = encodeURIComponent(allMentions[0].id());
    const bobId = encodeURIComponent(allMentions[1].id());

    const text = `Hello [Alice](${aliceId}) and [Bob](${bobId})!`;
    const extracted = ctrl.extractMentionsFromText(text);
    expect(extracted.length).toBe(2);
  });

  it("returns empty for text with no markdown links", () => {
    const ctrl = new MentionController(createMockHost());
    const cell = createMentionableCell(["Alice"]);
    ctrl.setMentionable(cell);

    const extracted = ctrl.extractMentionsFromText("Hello world");
    expect(extracted).toEqual([]);
  });

  it("ignores links that don't match any mentionable", () => {
    const ctrl = new MentionController(createMockHost());
    const cell = createMentionableCell(["Alice"]);
    ctrl.setMentionable(cell);

    const extracted = ctrl.extractMentionsFromText("[Unknown](unknown-id)");
    expect(extracted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("MentionController — lifecycle", () => {
  it("hide() resets state", () => {
    const content = "@ali";
    const cursor = 4;
    const ctrl = new MentionController(createMockHost(), {
      getContent: () => content,
      getCursorPosition: () => cursor,
    });
    ctrl.handleInput(new Event("input"));
    expect(ctrl.isShowing).toBe(true);

    ctrl.hide();
    expect(ctrl.isShowing).toBe(false);
    expect(ctrl.state.query).toBe("");
    expect(ctrl.state.selectedIndex).toBe(0);
  });

  it("selectMention updates selectedIndex", () => {
    const ctrl = new MentionController(createMockHost());
    ctrl.selectMention(3);
    expect(ctrl.state.selectedIndex).toBe(3);
  });

  it("setMentionable(null) clears mentionable", () => {
    const ctrl = new MentionController(createMockHost());
    const cell = createMentionableCell(["Alice"]);
    ctrl.setMentionable(cell);
    expect(ctrl.getFilteredMentions().length).toBe(1);

    ctrl.setMentionable(null);
    expect(ctrl.getFilteredMentions()).toEqual([]);
  });
});
