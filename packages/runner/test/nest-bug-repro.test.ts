/**
 * Reproduction test for nest-bug: Maximum recursion depth exceeded
 * when nesting pieces 3+ levels deep.
 *
 * Bug report: ./bug-report-piece-nesting.md
 *
 * ROOT CAUSE: The piece's output includes $UI (a VNode tree). The VNode
 * for a Notebook contains notes.map() which renders each child inline.
 * When a child is itself a notebook, its resolved output includes ANOTHER
 * $UI with notes.map(). This creates a deeply nested VNode structure.
 *
 * When handleCellSubscribe calls convertCellsToLinks(value, {
 * doNotConvertCellResults: true }), it walks the entire VNode tree via
 * Object.entries. The proxy's getOwnPropertyDescriptor increments depth
 * for each property, and array .map() increments depth for each element.
 * With 3 levels of notebook nesting, the VNode tree is deep enough to
 * push past MAX_RECURSION_DEPTH (100).
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test nest-bug");
const space = signer.did();

describe("nest-bug: recursion depth exceeded with nested piece data", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__maxProxyDepth = 0;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Simulate handleCellSubscribe code path */
  function simulateHandleCellSubscribe(proxy: unknown) {
    return convertCellsToLinks(proxy, {
      includeSchema: true,
      keepAsCell: true,
      doNotConvertCellResults: true,
    });
  }

  function getMaxDepth(): number {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).__maxProxyDepth ?? 0;
  }

  /**
   * Build a VNode-like structure that mirrors what the Notebook pattern renders.
   * Each notebook's $UI contains:
   *   ct-screen > div > ct-vstack > ct-card > ct-vstack > ct-table > tbody >
   *     [notes.map(note => tr > td > ct-drop-zone > ct-drag-source > div > ...)]
   *
   * When notes contain another notebook, that notebook's RESOLVED output
   * (including ITS $UI) gets included inline in the parent's VNode tree.
   */
  function makeVNode(tag: string, props: Record<string, any>, children: any[]) {
    return { t: tag, p: props, c: children };
  }

  function makeNoteVNode(title: string) {
    return makeVNode("tr", {}, [
      makeVNode("td", { style: { width: "32px" } }, [
        makeVNode("div", {}, [
          makeVNode("ct-checkbox", { checked: false }, []),
        ]),
      ]),
      makeVNode("td", {}, [
        makeVNode("ct-drop-zone", { accept: "note,notebook" }, [
          makeVNode("ct-drag-source", { type: "note" }, [
            makeVNode("div", { style: { cursor: "pointer" } }, [
              makeVNode("ct-cell-context", {}, [
                makeVNode("ct-chip", { label: title, interactive: true }, []),
              ]),
            ]),
          ]),
        ]),
      ]),
      makeVNode("td", {}, [
        makeVNode("ct-button", { size: "sm", variant: "ghost" }, ["✕"]),
      ]),
    ]);
  }

  function makeNotebookOutput(
    title: string,
    childOutputs: any[],
    depth: number = 0,
  ) {
    // Each child's resolved output (including its $UI) is rendered inline
    // when the parent's notes.map() iterates over them. This is why the
    // depth accumulates — each child notebook contributes its full VNode depth.
    const noteRows = childOutputs.map((child) => {
      // In the real runtime, child is a resolved piece output proxy.
      // The ct-cell-context wraps the child's cell reference.
      // The child's $UI and all its properties are accessible through the proxy.
      return makeVNode("tr", {
        style: { background: "transparent" },
      }, [
        makeVNode("td", {
          style: { width: "32px", padding: "0 4px", verticalAlign: "middle" },
        }, [
          makeVNode(
            "div",
            { style: { cursor: "pointer", userSelect: "none" } },
            [
              makeVNode("ct-checkbox", { checked: false }, []),
            ],
          ),
        ]),
        makeVNode("td", { style: { verticalAlign: "middle" } }, [
          makeVNode("ct-drop-zone", { accept: "note,notebook" }, [
            makeVNode("ct-drag-source", { type: "note" }, [
              makeVNode("div", { style: { cursor: "pointer" } }, [
                makeVNode("ct-cell-context", {}, [
                  makeVNode("ct-chip", {
                    label: child.$NAME ?? child.title ?? "Untitled",
                    interactive: true,
                  }, []),
                ]),
              ]),
            ]),
          ]),
        ]),
        makeVNode("td", { style: { width: "40px", verticalAlign: "middle" } }, [
          makeVNode("ct-button", { size: "sm", variant: "ghost" }, ["✕"]),
        ]),
      ]);
    });

    // Match the real notebook.tsx VNode tree structure closely
    const ui = makeVNode("ct-screen", {}, [
      makeVNode("div", { style: { flex: 1, overflow: "auto", minHeight: 0 } }, [
        makeVNode("ct-vstack", { gap: "4", padding: "6" }, [
          // Header row
          makeVNode("div", {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            },
          }, [
            makeVNode("ct-hstack", {
              gap: "2",
              align: "center",
              style: { display: "none" },
            }, [
              makeVNode("span", { style: { fontSize: "13px" } }, ["In:"]),
              makeVNode("ct-chip", { label: "Parent", interactive: true }, []),
            ]),
            makeVNode("div", { style: { display: "block" } }, []),
            makeVNode("ct-button", {
              variant: "ghost",
              style: { padding: "8px 16px", fontSize: "16px", display: "none" },
            }, ["📁 All Notes"]),
          ]),
          // Main card
          makeVNode("ct-card", {}, [
            makeVNode("ct-vstack", { gap: "4" }, [
              // Drop zone header
              makeVNode("ct-drop-zone", {
                accept: "sibling",
                style: { width: "100%" },
              }, [
                makeVNode("div", {
                  style: {
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px",
                    borderRadius: "8px",
                  },
                }, [
                  makeVNode("div", {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                    },
                  }, [
                    makeVNode("span", {
                      style: { margin: 0, fontSize: "15px", fontWeight: "600" },
                    }, [
                      `📓 ${title} (${childOutputs.length})`,
                    ]),
                  ]),
                  makeVNode("div", {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    },
                  }, [
                    makeVNode("ct-button", {
                      size: "sm",
                      variant: "ghost",
                      title: "New Note",
                    }, [
                      makeVNode("span", { style: { fontSize: "14px" } }, [
                        "📝",
                      ]),
                      makeVNode("span", {
                        style: { fontSize: "13px", fontWeight: "500" },
                      }, ["New"]),
                    ]),
                    makeVNode("ct-button", {
                      size: "sm",
                      variant: "ghost",
                      title: "New Notebook",
                    }, [
                      makeVNode("span", { style: { fontSize: "14px" } }, [
                        "📓",
                      ]),
                      makeVNode("span", {
                        style: { fontSize: "13px", fontWeight: "500" },
                      }, ["New"]),
                    ]),
                  ]),
                ]),
              ]),
              // Notes list
              makeVNode("ct-vstack", { gap: "0", style: { display: "flex" } }, [
                makeVNode("ct-table", { "full-width": true, hover: true }, [
                  makeVNode("tbody", {}, noteRows),
                ]),
                makeVNode("div", {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    padding: "4px 0",
                    fontSize: "13px",
                  },
                }, [
                  makeVNode("div", {
                    style: { width: "32px", padding: "0 4px" },
                  }, [
                    makeVNode("ct-checkbox", { checked: false }, []),
                  ]),
                  makeVNode("span", { style: { paddingLeft: "4px" } }, [
                    "Select All",
                  ]),
                ]),
              ]),
              // Action bar
              makeVNode("ct-hstack", {
                padding: "3",
                gap: "3",
                style: {
                  display: "none",
                  background: "var(--ct-color-bg-secondary)",
                  borderRadius: "8px",
                },
              }, [
                makeVNode("span", {
                  style: { fontSize: "13px", fontWeight: "500" },
                }, ["0 selected"]),
              ]),
            ]),
          ]),
        ]),
      ]),
      // Modals
      makeVNode("ct-modal", {
        dismissable: true,
        size: "sm",
        label: "New Notebook",
      }, [
        makeVNode("span", { slot: "header" }, ["New Notebook"]),
        makeVNode("ct-input", { placeholder: "Enter notebook name..." }, []),
      ]),
      makeVNode("ct-modal", {
        dismissable: true,
        size: "sm",
        label: "New Note",
      }, [
        makeVNode("span", { slot: "header" }, ["New Note"]),
        makeVNode("ct-input", { placeholder: "Enter note title..." }, []),
      ]),
      makeVNode("ct-modal", {
        dismissable: true,
        size: "sm",
        label: "New Notebook",
      }, [
        makeVNode("span", { slot: "header" }, ["New Notebook"]),
        makeVNode("ct-input", { placeholder: "Enter notebook title..." }, []),
      ]),
      // Backlinks footer
      makeVNode("ct-hstack", {
        slot: "footer",
        gap: "2",
        padding: "3",
        style: {
          display: "none",
          alignItems: "center",
          borderTop: "1px solid var(--ct-color-border)",
        },
      }, [
        makeVNode("span", { style: { fontSize: "12px", lineHeight: "28px" } }, [
          "Linked from:",
        ]),
      ]),
    ]);

    return {
      "$NAME": `📓 ${title} (${childOutputs.length})`,
      title,
      isNotebook: true,
      isHidden: depth > 0,
      notes: childOutputs,
      noteCount: childOutputs.length,
      backlinks: [],
      selectedNoteIndices: [],
      selectedCount: 0,
      hasSelection: false,
      showNewNotePrompt: false,
      showNewNotebookPrompt: false,
      showNewNestedNotebookPrompt: false,
      isEditingTitle: false,
      mentionable: childOutputs,
      "$UI": ui,
    };
  }

  function makeNoteOutput(title: string) {
    return {
      "$NAME": `📝 ${title}`,
      title,
      content: "leaf",
      noteId: title.toLowerCase().replace(/\s/g, "-"),
      isHidden: true,
      backlinks: [],
      parentNotebook: null,
    };
  }

  it("3-level nesting with VNode-like $UI tree stored in single cell", () => {
    // Build the full output shape including nested $UI VNode trees
    const noteAG1 = makeNoteOutput("Note AG1");
    const grandchild = makeNotebookOutput("A-Grandchild", [noteAG1], 2);

    const noteAC1 = makeNoteOutput("Note AC1");
    const childNotebook = makeNotebookOutput(
      "A-Child",
      [noteAC1, grandchild],
      1,
    );

    const noteA1 = makeNoteOutput("Note A1");
    const parentNotebook = makeNotebookOutput("Notebook A", [
      noteA1,
      childNotebook,
    ], 0);

    const cell = runtime.getCell<any>(space, "vnode-3-level", undefined, tx);
    cell.set(parentNotebook);

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    try {
      const result = simulateHandleCellSubscribe(proxy);
      console.log("[vnode-3-level] Max depth:", getMaxDepth());
      console.log(
        "[vnode-3-level] Succeeded:",
        JSON.stringify(result).slice(0, 200),
      );
    } catch (e) {
      const msg = (e as Error).message;
      console.log("[vnode-3-level] Max depth:", getMaxDepth());
      console.log("[vnode-3-level] Threw:", msg);
      expect(msg).toContain("Maximum recursion depth");
    }
  });

  it("3-level nesting with each notebook in its OWN cell (linked via refs)", () => {
    // This matches the real runtime: each Notebook() and Note() call creates
    // a separate cell. The parent's notes array contains link refs to children.
    // When the proxy resolves links, the child's full output (including $UI)
    // is transparently accessible.

    const noteAG1Cell = runtime.getCell<any>(space, "cell-ag1", undefined, tx);
    noteAG1Cell.set(makeNoteOutput("Note AG1"));

    const gcCell = runtime.getCell<any>(space, "cell-gc", undefined, tx);
    gcCell.set({
      ...makeNotebookOutput("A-Grandchild", [makeNoteOutput("Note AG1")], 2),
      notes: [noteAG1Cell.getAsLink()],
    });

    const noteAC1Cell = runtime.getCell<any>(space, "cell-ac1", undefined, tx);
    noteAC1Cell.set(makeNoteOutput("Note AC1"));

    const childCell = runtime.getCell<any>(space, "cell-child", undefined, tx);
    childCell.set({
      ...makeNotebookOutput("A-Child", [
        makeNoteOutput("Note AC1"),
        makeNotebookOutput("A-Grandchild", [makeNoteOutput("Note AG1")], 2),
      ], 1),
      notes: [noteAC1Cell.getAsLink(), gcCell.getAsLink()],
    });

    const noteA1Cell = runtime.getCell<any>(space, "cell-a1", undefined, tx);
    noteA1Cell.set(makeNoteOutput("Note A1"));

    const parentCell = runtime.getCell<any>(
      space,
      "cell-parent",
      undefined,
      tx,
    );
    parentCell.set({
      ...makeNotebookOutput("Notebook A", [
        makeNoteOutput("Note A1"),
        makeNotebookOutput("A-Child", [], 1),
      ], 0),
      notes: [noteA1Cell.getAsLink(), childCell.getAsLink()],
    });

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      parentCell.getAsNormalizedFullLink(),
      0,
      false,
    );

    try {
      const result = simulateHandleCellSubscribe(proxy);
      console.log("[linked-vnode-3] Max depth:", getMaxDepth());
      console.log(
        "[linked-vnode-3] Succeeded:",
        JSON.stringify(result).slice(0, 300),
      );
    } catch (e) {
      const msg = (e as Error).message;
      console.log("[linked-vnode-3] Max depth:", getMaxDepth());
      console.log("[linked-vnode-3] Threw:", msg);
      expect(msg).toContain("Maximum recursion depth");
    }
  });

  it("proxy identity: seen Map cannot detect repeated proxy access", () => {
    // This demonstrates WHY the seen Map fails for proxies.
    // Each property access on a proxy returns a NEW object wrapper,
    // so seen.has() never matches a previously-visited value.
    const cell = runtime.getCell<any>(space, "proxy-identity", undefined, tx);
    cell.set({
      a: { nested: { value: 42 } },
    });

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    // Access the same property twice — are they the same object?
    const first = proxy.a;
    const second = proxy.a;
    console.log("[proxy-identity] proxy.a === proxy.a:", first === second);
    console.log(
      "[proxy-identity] proxy.a.nested === proxy.a.nested:",
      first.nested === second.nested,
    );

    // This is why seen.has() fails — each access returns a different object
    const seen = new Map();
    seen.set(first, ["first"]);
    console.log("[proxy-identity] seen.has(first):", seen.has(first));
    console.log("[proxy-identity] seen.has(second):", seen.has(second));

    // In the real bug, convertCellsToLinks walks proxy objects and each
    // sub-proxy is a new object, so cycle detection via seen Map fails.
    expect(first === second).toBe(false); // Different objects!
    expect(seen.has(second)).toBe(false); // Can't detect it's the "same" value
  });

  it("convertCellsToLinks WITHOUT doNotConvertCellResults: always succeeds (baseline)", () => {
    const cell = runtime.getCell<any>(space, "baseline", undefined, tx);
    cell.set({
      title: "Deep",
      isNotebook: true,
      notes: [{
        title: "Child",
        isNotebook: true,
        notes: [{ title: "Note", content: "leaf" }],
      }],
    });

    const proxy = createQueryResultProxy<any>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
      false,
    );

    const result = convertCellsToLinks(proxy);
    expect(result["/"]).toBeDefined();
  });
});
