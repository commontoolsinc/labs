import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { $conn, CellHandle, RequestType } from "@commonfabric/runtime-client";
import type {
  CellRef,
  PieceSourceView,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  CFPieceMenu,
  formatPieceValue,
  isStreamHandle,
  openPieceMenu,
  pieceMenuEntries,
} from "./cf-piece-menu.ts";
import {
  describeOrigin,
  formatTimestamp,
  shortIdentity,
} from "./origin-view.ts";

// The menu renders through Lit templates rather than into a real DOM here: the
// assertions read the template a render produced, which is enough to say what
// the menu shows and when. Its behaviour against a live piece — the portalled
// overlay, positioning, the click path — is driven end to end by
// packages/shell/integration/piece-menu.test.ts.

/** The static text and interpolated values of a rendered Lit template. */
function textOf(node: unknown): string {
  // `nothing` — Lit's render-nothing sentinel — is a symbol, and contributes no
  // text, like the other empty values.
  if (
    node === null || node === undefined || typeof node === "boolean" ||
    typeof node === "symbol"
  ) {
    return "";
  }
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (template.strings && template.values) {
      return template.strings
        .map((part, index) => part + textOf(template.values![index]))
        .join("");
    }
    return "";
  }
  return String(node);
}

/** What the menu shows now. `render` is the component's own protected hook. */
function shows(menu: CFPieceMenu): string {
  return textOf((menu as unknown as { render(): unknown }).render());
}

const SPACE = "did:key:z6Mk-piece-menu" as const;

const SOURCE: PieceSourceView = {
  space: SPACE,
  pieceId: "of:fid1:piece",
  name: "Recipe",
  pattern: { identity: "pattern-identity-value", symbol: "default" },
  origin: { url: "https://example.test/recipe.tsx", kind: "web" },
  entry: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: "the main file" },
    { name: "/helper.tsx", contents: "the helper file" },
  ],
};

/**
 * A piece whose runtime answers one source read. `read` decides what that read
 * does, so a test can resolve it, reject it, or leave it pending.
 */
function pieceCell(
  read: () => Promise<PieceSourceView> = () => Promise.resolve(SOURCE),
  { aborted = false } = {},
): CellHandle {
  return {
    id: () => "of:fid1:piece",
    space: () => SPACE,
    runtime: () => ({
      getPieceSource: read,
      signal: { aborted },
    }),
  } as unknown as CellHandle;
}

/**
 * A menu whose state changes do not schedule a Lit update: there is no DOM to
 * render into here, and every assertion renders explicitly.
 */
function newMenu(): CFPieceMenu {
  const menu = new CFPieceMenu();
  // Lit's own update pass wants a DOM to render into; every assertion here
  // renders explicitly instead.
  (menu as unknown as { performUpdate(): void }).performUpdate = () => {};
  return menu;
}

function openMenu(cell: CellHandle = pieceCell()): CFPieceMenu {
  const menu = newMenu();
  menu.open({ cell, x: 40, y: 60 });
  return menu;
}

describe("piece menu entries", () => {
  it("offers exactly the four entries, in order", () => {
    expect(pieceMenuEntries().map((entry) => entry.label)).toEqual([
      "View source",
      "Origin and history",
      "Data",
      "Actions",
    ]);
  });

  it("gives each entry a stable hook a host's tests can select", () => {
    expect(pieceMenuEntries().map((entry) => entry.testId)).toEqual([
      "piece-menu-source",
      "piece-menu-origin",
      "piece-menu-data",
      "piece-menu-actions",
    ]);
  });
});

describe("the menu a right-click opens", () => {
  it("names the piece and offers every entry", () => {
    const rendered = shows(openMenu());
    expect(rendered).toContain("of:fid1:piece");
    for (const entry of pieceMenuEntries()) {
      expect(rendered).toContain(entry.label);
      expect(rendered).toContain(entry.testId);
    }
  });

  it("shows nothing until it is opened, or once closed", () => {
    const menu = newMenu();
    expect(shows(menu)).toBe("");
    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    expect(shows(menu)).toContain("View source");
    menu.close();
    expect(shows(menu)).toBe("");
  });

  it("keeps itself inside the viewport", () => {
    const menu = newMenu();
    menu.open({ cell: pieceCell(), x: 1_000_000, y: 1_000_000 });
    const placement = shows(menu);
    // Clamped rather than drawn off-screen, wherever the click landed.
    expect(placement).toContain("left: ");
    expect(placement).not.toContain("left: 1000000px");
  });
});

describe("the source panel", () => {
  it("shows the entry file, with a tab per file", async () => {
    const menu = openMenu();
    await menu.showPanel("source");

    const rendered = shows(menu);
    expect(rendered).toContain("Source");
    expect(rendered).toContain("Recipe");
    expect(rendered).toContain("the main file");
    expect(rendered).toContain("/helper.tsx");
  });

  it("switches to the file a tab selects", async () => {
    const menu = openMenu();
    await menu.showPanel("source");
    expect(shows(menu)).toContain("the main file");

    menu.selectFile(1);
    expect(shows(menu)).toContain("the helper file");
  });

  it("reads the piece once for both panels", async () => {
    let reads = 0;
    const menu = openMenu(pieceCell(() => {
      reads++;
      return Promise.resolve(SOURCE);
    }));

    await menu.showPanel("source");
    await menu.showPanel("origin");
    await menu.showPanel("source");

    expect(reads).toBe(1);
  });

  it("says so when the piece's source is not in its space", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({ ...SOURCE, entry: undefined, files: [] })
      ),
    );
    await menu.showPanel("source");

    const rendered = shows(menu);
    expect(rendered).toContain("not available in its space");
    expect(rendered).toContain("pattern-identity-value");
  });

  it("reports a read that failed", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.reject(new Error("no read"))),
    );
    await menu.showPanel("source");

    expect(shows(menu)).toContain("no read");
  });

  it("stays quiet when the runtime was disposed mid-read", async () => {
    // A disposal race is cancellation, not a failure to report.
    const menu = openMenu(
      pieceCell(() => Promise.reject(new Error("gone")), { aborted: true }),
    );
    await menu.showPanel("source");

    expect(shows(menu)).not.toContain("gone");
  });

  it("drops a failed read that a later opening replaced", async () => {
    let failRead!: (error: Error) => void;
    const menu = openMenu(
      pieceCell(() =>
        new Promise<PieceSourceView>((_resolve, reject) => {
          failRead = reject;
        })
      ),
    );
    const pending = menu.showPanel("source");

    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    failRead(new Error("failed after reopening"));
    await pending;

    // The failure belongs to the piece the menu no longer shows.
    expect(shows(menu)).not.toContain("failed after reopening");
  });

  it("drops a read that a later opening replaced", async () => {
    let resolveRead!: (source: PieceSourceView) => void;
    const menu = openMenu(
      pieceCell(() =>
        new Promise<PieceSourceView>((resolve) => {
          resolveRead = resolve;
        })
      ),
    );
    const pending = menu.showPanel("source");

    // Reopening for another piece invalidates the read in flight.
    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    resolveRead({ ...SOURCE, name: "Stale" });
    await pending;

    expect(shows(menu)).not.toContain("Stale");
  });
});

describe("the origin and history panel", () => {
  it("names the origin and the facts behind it", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("External web URL");
    expect(rendered).toContain("https://example.test/recipe.tsx");
    expect(rendered).toContain(shortIdentity("pattern-identity-value"));
    expect(rendered).toContain("/main.tsx");
    expect(rendered).toContain("of:fid1:piece");
    expect(rendered).toContain(SPACE);
    expect(rendered).toContain("not recorded yet");
  });

  it("says a piece with no origin is detached", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.resolve({ ...SOURCE, origin: undefined })),
    );
    await menu.showPanel("origin");

    expect(shows(menu)).toContain("Detached");
  });

  it("shows the recorded form of an origin that was normalized", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          origin: {
            url: "https://toolshed.test/api/patterns/system/home.tsx",
            kind: "web",
            recorded: "/api/patterns/system/home.tsx",
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Recorded as");
    expect(rendered).toContain("/api/patterns/system/home.tsx");
  });

  it("shows a setup identity only when it differs from the running one", async () => {
    const same = openMenu(
      pieceCell(() =>
        Promise.resolve({ ...SOURCE, setupPattern: SOURCE.pattern })
      ),
    );
    await same.showPanel("origin");
    expect(shows(same)).not.toContain("Setup applied for");

    const differs = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          setupPattern: { identity: "older-identity", symbol: "default" },
        })
      ),
    );
    await differs.showPanel("origin");
    expect(shows(differs)).toContain("Setup applied for");
  });

  it("shows a displaced pattern with the time it was replaced", async () => {
    const displacedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          displacedPattern: {
            identity: "displaced-identity",
            symbol: "default",
            displacedAt,
          },
          repository: "https://github.com/example/recipes",
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Previously ran");
    expect(rendered).toContain(formatTimestamp(displacedAt));
    expect(rendered).toContain("Repository");
    expect(rendered).toContain("https://github.com/example/recipes");
  });
});

/**
 * A live-ish piece for the data and actions panels: a real `CellHandle` (the
 * panels detect streams with `instanceof`) over a fake connection that
 * records every request it is asked to make.
 */
function statefulPiece(
  {
    result = {},
    argument = {} as unknown,
    getPageFails = false,
    sendFails = false,
  }: {
    result?: Record<string, unknown>;
    argument?: unknown;
    getPageFails?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const conn = {
    subscribe: () => {},
    unsubscribe: () => Promise.resolve(),
    request: (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.type === RequestType.CellGet) {
        return Promise.resolve({ value: argument });
      }
      if (request.type === RequestType.CellSet) {
        return Promise.resolve({});
      }
      if (request.type === RequestType.CellSend) {
        return sendFails
          ? Promise.reject(new Error("handler refused the event"))
          : Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected request: ${request.type}`));
    },
    signal: { aborted: false },
  };
  const rt = {
    [$conn]: () => conn,
    signal: { aborted: false },
    getPieceSource: () => Promise.resolve(SOURCE),
    getPage: (..._args: unknown[]) =>
      getPageFails
        ? Promise.reject(new Error("no page for this piece"))
        : Promise.resolve(page),
  } as unknown as RuntimeClient;

  const pieceRef: CellRef = {
    id: "of:fid1:piece",
    space: SPACE,
    path: [],
    schema: { type: "object" },
  } as unknown as CellRef;
  const cell = new CellHandle(rt, pieceRef, result);
  const page = { cell: () => cell };

  /** A nested handler stream, tagged the way a schema'd read tags one. */
  const streamHandle = (name: string): CellHandle =>
    new CellHandle(rt, {
      id: "of:fid1:piece",
      space: SPACE,
      path: [name],
      schema: { asCell: ["stream"] },
    } as unknown as CellRef);

  return { cell, requests, streamHandle, rt };
}

describe("the data panel", () => {
  it("shows the argument and the result", async () => {
    const piece = statefulPiece({
      argument: { title: "hello input" },
      result: {},
    });
    // The result carries a plain field, a linked cell, and a stream.
    await piece.cell.set({
      count: 3,
      addItem: piece.streamHandle("addItem"),
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    const rendered = shows(menu);
    expect(rendered).toContain("Argument");
    expect(rendered).toContain("hello input");
    expect(rendered).toContain("Result");
    expect(rendered).toContain('"count": 3');
    expect(rendered).toContain("[stream]");
  });

  it("omits the view keys, which hold VDOM rather than data", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ real: "data", $UI: { huge: "vdom" } });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    const rendered = shows(menu);
    expect(rendered).toContain("real");
    expect(rendered).not.toContain("vdom");
  });

  it("reads the piece state once for data and actions", async () => {
    const piece = statefulPiece({ argument: { a: 1 } });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");
    await menu.showPanel("actions");
    await menu.showPanel("data");

    const argumentReads = piece.requests.filter(
      (request) => request.type === RequestType.CellGet,
    );
    expect(argumentReads.length).toBe(1);
  });

  it("reports a data read that failed", async () => {
    const piece = statefulPiece({ getPageFails: true });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    expect(shows(menu)).toContain("no page for this piece");
  });
});

describe("the actions panel", () => {
  it("lists the piece's handler streams", async () => {
    const piece = statefulPiece({ argument: { plain: "value" } });
    await piece.cell.set({
      addItem: piece.streamHandle("addItem"),
      clear: piece.streamHandle("clear"),
      count: 3,
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const rendered = shows(menu);
    expect(rendered).toContain("addItem");
    expect(rendered).toContain("clear");
    expect(rendered).toContain("piece-action-addItem");
    // Plain fields are data, not actions.
    expect(rendered).not.toContain("piece-action-count");
  });

  it("says so when the piece exposes no handlers", async () => {
    const piece = statefulPiece({ argument: { a: 1 } });
    await piece.cell.set({ count: 3 });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    expect(shows(menu)).toContain("no handler streams");
  });

  it("dispatches an event with the JSON payload entered", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    (menu as unknown as { payloadText: string }).payloadText =
      '{ "title": "new item" }';
    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    const sends = piece.requests.filter(
      (request) => request.type === RequestType.CellSend,
    );
    expect(sends.length).toBe(1);
    expect(sends[0].event).toEqual({ title: "new item" });
    expect((sends[0].cell as CellRef).path).toEqual(["addItem"]);
    expect(shows(menu)).toContain("Sent to addItem");
  });

  it("rejects an unparsable payload without dispatching", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    (menu as unknown as { payloadText: string }).payloadText = "{not json";
    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    expect(shows(menu)).toContain("not valid JSON");
    expect(
      piece.requests.filter((r) => r.type === RequestType.CellSend).length,
    ).toBe(0);
  });

  it("reports a dispatch the runtime refused", async () => {
    const piece = statefulPiece({ sendFails: true });
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    expect(shows(menu)).toContain("handler refused the event");
  });
});

describe("formatPieceValue", () => {
  it("stubs a linked cell instead of printing its sigil form", () => {
    const piece = statefulPiece();
    const linked = new CellHandle(piece.rt, {
      id: "of:fid1:other",
      space: SPACE,
      path: ["items", "0"],
      schema: { type: "object" },
    } as unknown as CellRef);

    const formatted = formatPieceValue({ item: linked });
    expect(formatted).toContain('"@cell": "of:fid1:other"');
    expect(formatted).toContain("items/0");
  });

  it("caps the depth of a deep value", () => {
    type Deep = { deeper?: Deep; leaf?: string };
    let value: Deep = { leaf: "bottom" };
    for (let i = 0; i < 12; i++) value = { deeper: value };

    const formatted = formatPieceValue(value);
    expect(formatted).toContain("…");
    expect(formatted).not.toContain("bottom");
  });
});

describe("isStreamHandle", () => {
  it("recognizes only handles whose schema declares a stream", () => {
    const piece = statefulPiece();
    expect(isStreamHandle(piece.streamHandle("go"))).toBe(true);
    expect(isStreamHandle(piece.cell)).toBe(false);
    expect(isStreamHandle({ $stream: true })).toBe(false);
    expect(isStreamHandle("addItem")).toBe(false);
  });
});

describe("dismissing the menu", () => {
  /** Send a keydown the way the browser would, since the menu listens globally. */
  function pressKey(key: string): void {
    const event = new Event("keydown", { cancelable: true });
    (event as unknown as { key: string }).key = key;
    globalThis.dispatchEvent(event);
  }

  it("steps back from a panel to the menu, then closes", async () => {
    const menu = openMenu();
    menu.connectedCallback();
    try {
      await menu.showPanel("origin");
      expect(shows(menu)).toContain("Origin and history");

      pressKey("Escape");
      expect(shows(menu)).toContain("View source");

      pressKey("Escape");
      expect(shows(menu)).toBe("");
    } finally {
      menu.disconnectedCallback();
    }
  });

  it("dismisses on a right-click on the backdrop", () => {
    const menu = openMenu();
    let prevented = false;
    (menu as unknown as { _onBackdropContextMenu(e: Event): void })
      ._onBackdropContextMenu(
        { preventDefault: () => (prevented = true) } as unknown as Event,
      );

    // The platform menu does not open over the dismissed piece menu.
    expect(prevented).toBe(true);
    expect(shows(menu)).toBe("");
  });

  it("ignores keys that are not Escape", () => {
    const menu = openMenu();
    menu.connectedCallback();
    try {
      pressKey("Enter");
      expect(shows(menu)).toContain("View source");
    } finally {
      menu.disconnectedCallback();
    }
  });
});

describe("openPieceMenu", () => {
  /** A document stub: the menu mounts on `document.body`, outside any piece. */
  function installDocument(): { restore: () => void; appended: unknown[] } {
    const appended: unknown[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalComputed = Object.getOwnPropertyDescriptor(
      globalThis,
      "getComputedStyle",
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        createElement: () => {
          const element = newMenu();
          // The shim element has no style object of its own.
          (element as unknown as { style: unknown }).style = {
            setProperty: () => {},
            removeProperty: () => {},
          };
          return element;
        },
        body: {
          appendChild: (element: unknown) => {
            appended.push(element);
            (element as { isConnected?: boolean }).isConnected = true;
            return element;
          },
        },
      },
    });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      writable: true,
      value: () => ({
        getPropertyValue: (name: string) =>
          name === "--cf-theme-color-surface" ? "#101010" : "",
      }),
    });
    return {
      appended,
      restore: () => {
        if (original) Object.defineProperty(globalThis, "document", original);
        else Reflect.deleteProperty(globalThis, "document");
        if (originalComputed) {
          Object.defineProperty(
            globalThis,
            "getComputedStyle",
            originalComputed,
          );
        } else Reflect.deleteProperty(globalThis, "getComputedStyle");
      },
    };
  }

  it("mounts one menu and reuses it for the next right-click", () => {
    const { appended, restore } = installDocument();
    try {
      const first = openPieceMenu({ cell: pieceCell(), x: 10, y: 20 });
      const second = openPieceMenu({ cell: pieceCell(), x: 30, y: 40 });

      // One overlay, reopened — a second right-click replaces the menu rather
      // than stacking another on top of it.
      expect(second).toBe(first);
      expect(appended.length).toBe(1);
      expect(shows(second)).toContain("View source");
    } finally {
      restore();
    }
  });

  it("adopts the theme of the element the click came from", () => {
    const { restore } = installDocument();
    const applied: Array<[string, string]> = [];
    try {
      const themeFrom = {} as unknown as Element;
      const menu = openPieceMenu({
        cell: pieceCell(),
        x: 0,
        y: 0,
        themeFrom,
      });
      (menu as unknown as { style: unknown }).style = {
        setProperty: (name: string, value: string) =>
          applied.push([name, value]),
        removeProperty: () => {},
      };
      // Reopening with the same host re-copies onto the recorded style stub.
      openPieceMenu({ cell: pieceCell(), x: 0, y: 0, themeFrom });

      expect(applied).toContainEqual(["--cf-theme-color-surface", "#101010"]);
    } finally {
      restore();
    }
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
