/**
 * VDOM debug helpers for browser console inspection.
 *
 * Usage: commontools.vdom.dump()   — pretty-print the VDOM tree
 *        commontools.vdom.renders() — list all active renderings
 *        commontools.vdom.stats()   — node/listener counts
 */

import { type CellHandle, isCellHandle } from "@commontools/runtime-client";
import { debugVDOMSchema } from "@commontools/runner/schemas";
import { type ActiveRender, getActiveRenders } from "./render.ts";

/**
 * Resolve an optional element-or-index argument to an ActiveRender entry.
 * - undefined → first (or only) entry
 * - number   → entry at that index
 * - element  → entry keyed by that element
 */
function resolveTarget(
  elementOrIndex?: HTMLElement | number,
): ActiveRender | undefined {
  const renders = getActiveRenders();
  if (renders.size === 0) return undefined;

  if (elementOrIndex === undefined) {
    return renders.values().next().value;
  }

  if (typeof elementOrIndex === "number") {
    let i = 0;
    for (const entry of renders.values()) {
      if (i === elementOrIndex) return entry;
      i++;
    }
    return undefined;
  }

  return renders.get(elementOrIndex);
}

/**
 * Subscribe to a cell and resolve with the first defined value.
 * CellHandle.get() only returns cached values; asSchema() creates a new handle
 * with no cache, so we subscribe and wait for the runtime to deliver the value.
 */
function readCellAsync<T>(cell: CellHandle<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const cancel = cell.subscribe((v) => {
      if (v !== undefined && !settled) {
        settled = true;
        // Defer cancel to avoid unsubscribe during callback
        queueMicrotask(() => cancel());
        resolve(v);
      }
    });
    // If the callback fired synchronously with a defined value, we're done.
    // Otherwise set a timeout so we don't hang forever.
    if (!settled) {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          cancel();
          resolve(undefined);
        }
      }, 30000);
    }
  });
}

/**
 * Recursively format a VDOM tree node into a readable string.
 * CellHandle props are shown as `<cell>`.
 */
function formatTree(node: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (node == null) return `${pad}(null)`;
  if (typeof node === "string") return `${pad}"${node}"`;
  if (typeof node === "number" || typeof node === "boolean") {
    return `${pad}${String(node)}`;
  }
  if (Array.isArray(node)) {
    return node.map((child) => formatTree(child, indent)).join("\n");
  }
  if (typeof node !== "object") return `${pad}${String(node)}`;

  const obj = node as Record<string, unknown>;

  // Always follow $UI indirection, matching the render code's behavior
  // (render.ts follows the [UI] chain unconditionally before processing)
  if ("$UI" in obj && obj.$UI) {
    return formatTree(obj.$UI, indent);
  }

  const name = obj.name as string | undefined;
  if (!name) {
    // Not a vdom node — try to stringify
    try {
      return `${pad}${JSON.stringify(node)}`;
    } catch {
      return `${pad}[object]`;
    }
  }

  // Format props
  const props = obj.props as Record<string, unknown> | undefined;
  let propsStr = "";
  if (props && typeof props === "object") {
    const propParts: string[] = [];
    for (const [key, value] of Object.entries(props)) {
      if (isCellHandle(value)) {
        propParts.push(`${key}=<cell>`);
      } else if (typeof value === "string") {
        propParts.push(`${key}="${value}"`);
      } else {
        try {
          propParts.push(`${key}=${JSON.stringify(value)}`);
        } catch {
          propParts.push(`${key}=[object]`);
        }
      }
    }
    if (propParts.length > 0) {
      propsStr = " " + propParts.join(" ");
    }
  }

  // Format children
  const children = obj.children as unknown[] | undefined;
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return `${pad}<${name}${propsStr} />`;
  }

  const childLines = Array.isArray(children)
    ? children.map((child) => formatTree(child, indent + 1)).join("\n")
    : formatTree(children, indent + 1);

  return `${pad}<${name}${propsStr}>\n${childLines}\n${pad}</${name}>`;
}

/**
 * Create the debug helpers object to register on globalThis.commontools.vdom.
 */
export function createVDomDebugHelpers() {
  return {
    /**
     * List all active renderings in a console.table.
     */
    renders() {
      const renders = getActiveRenders();
      if (renders.size === 0) {
        console.log("No active renders.");
        return;
      }
      const rows: Record<string, unknown>[] = [];
      let i = 0;
      for (const [parent, entry] of renders) {
        rows.push({
          index: i++,
          container: parent,
          cellId: entry.cell?.ref()?.id ?? "(none)",
          path: entry.path,
          renderer: entry.renderer ? "VDomRenderer" : "(legacy)",
        });
      }
      console.table(rows);
    },

    /**
     * Read the VDOM tree using the debug schema (children expanded inline).
     * Returns the raw tree object for inspection.
     */
    async tree(el?: HTMLElement | number) {
      const target = resolveTarget(el);
      if (!target) {
        console.warn("No active render found.");
        return undefined;
      }
      if (!target.cell) {
        console.warn("No cell handle available (legacy render without cell).");
        return undefined;
      }
      return await readCellAsync(target.cell.asSchema(debugVDOMSchema));
    },

    /**
     * Pretty-print the VDOM tree to the console.
     */
    async dump(el?: HTMLElement | number) {
      const target = resolveTarget(el);
      if (!target) {
        console.warn("No active render found.");
        return;
      }
      if (!target.cell) {
        console.warn("No cell handle available (legacy render without cell).");
        return;
      }
      const tree = await readCellAsync(
        target.cell.asSchema(debugVDOMSchema),
      );
      if (!tree) {
        console.warn("Tree is empty.");
        return;
      }
      console.log(formatTree(tree));
    },

    /**
     * Show node/listener counts per active renderer (worker path only).
     */
    stats() {
      const renders = getActiveRenders();
      if (renders.size === 0) {
        console.log("No active renders.");
        return;
      }
      const rows: Record<string, unknown>[] = [];
      let i = 0;
      for (const [parent, entry] of renders) {
        if (entry.renderer) {
          const info = entry.renderer.getApplicator().getDebugInfo();
          rows.push({
            index: i,
            container: parent,
            nodeCount: info.nodeCount,
            listenerCount: info.listenerCount,
            totalListeners: info.totalListeners,
            rootNodeId: info.rootNodeId,
          });
        } else {
          rows.push({
            index: i,
            container: parent,
            nodeCount: "(legacy)",
            listenerCount: "(legacy)",
            totalListeners: "(legacy)",
            rootNodeId: "(legacy)",
          });
        }
        i++;
      }
      console.table(rows);
    },

    /**
     * Look up a DOM node from an applicator node ID.
     */
    nodeForId(id: number, el?: HTMLElement | number): Node | undefined {
      const target = resolveTarget(el);
      if (!target?.renderer) {
        console.warn("No worker-path renderer found.");
        return undefined;
      }
      return target.renderer.getApplicator().getNode(id);
    },

    /**
     * Raw access to the active renders registry.
     */
    get registry() {
      return getActiveRenders();
    },
  };
}
