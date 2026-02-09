import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { CellHandle } from "@commontools/runtime-client";
import {
  type DiscoveredLink,
  discoverLinksFromValue,
  resolveAndCheckNavigable,
} from "./link-discovery.ts";

/**
 * Reactive controller for discovering links from a cell.
 *
 * This controller:
 * - Subscribes to a cell's updates
 * - Re-discovers all outgoing links whenever the cell value changes
 * - Triggers host updates when links change
 * - Properly cleans up subscriptions when unbound or disconnected
 *
 * Usage:
 * ```typescript
 * class MyComponent extends LitElement {
 *   private linksController = new LinksFromController(this);
 *
 *   connectedCallback() {
 *     super.connectedCallback();
 *     if (this.cell) {
 *       this.linksController.bind(this.cell);
 *     }
 *   }
 *
 *   render() {
 *     return html`
 *       <div>Found ${this.linksController.links.length} links</div>
 *     `;
 *   }
 * }
 * ```
 */
export class LinksFromController implements ReactiveController {
  private host: ReactiveControllerHost;
  private cell?: CellHandle<any>;
  private cancelSubscription?: () => void;

  /**
   * The discovered links from the current cell.
   * Updated reactively whenever the cell value changes.
   */
  links: DiscoveredLink[] = [];

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.host.addController(this);
  }

  /**
   * Bind to a cell and start tracking its links.
   * Automatically unsubscribes from any previously bound cell.
   *
   * @param cell - The cell to track links from
   */
  bind(cell: CellHandle<any>): void {
    // Unbind from previous cell if any
    if (this.cancelSubscription) {
      this.unbind();
    }

    // The PageHandle's cell may have a restrictive schema (like nameSchema)
    // that only includes $NAME. To get all properties including links,
    // we need to use a broader schema. Using `true` means "any value".
    const fullCell = cell.asSchema<Record<string, unknown>>(true as any);

    this.cell = fullCell;

    // Subscribe to cell updates - the subscription handles syncing
    this.cancelSubscription = fullCell.subscribe(() => {
      // Re-discover links whenever the cell value changes
      this.discoverLinks();
    });

    // Perform initial sync and discovery
    // The subscribe() above will trigger discovery after sync completes,
    // but we also sync explicitly to ensure we have data
    fullCell.sync().then(() => {
      this.discoverLinks();
    });
  }

  /**
   * Unbind from the current cell and stop tracking links.
   * Cleans up the subscription and clears the links array.
   */
  unbind(): void {
    if (this.cancelSubscription) {
      this.cancelSubscription();
      this.cancelSubscription = undefined;
    }

    this.cell = undefined;
    this.links = [];
    this.host.requestUpdate();
  }

  /**
   * Discover links from the current cell and update the links array.
   * Searches the result cell, plus the pattern's argument and internal cells.
   * Only includes navigable pieces (cells with $NAME).
   * Triggers a host update when links change.
   */
  private async discoverLinks(): Promise<void> {
    if (!this.cell) {
      this.links = [];
      return;
    }

    // Get the current value from the result cell
    const value = this.cell.get();
    console.log("[discoverLinks] Result cell value:", value);
    console.log(
      "[discoverLinks] Result cell keys:",
      value && typeof value === "object" ? Object.keys(value) : "not object",
    );
    if (value === undefined) {
      this.links = [];
      return;
    }

    // Discover links from the result cell
    const allLinks = discoverLinksFromValue(value);
    console.log("[discoverLinks] Links from result cell:", allLinks.length);

    // Also traverse the pattern's argument and internal cells via the source cell
    try {
      const sourceCell = await this.cell.getSourceCell();
      if (sourceCell) {
        console.log("[discoverLinks] Got source cell:", sourceCell.ref());

        // Get the source cell value with broad schema
        const sourceCellWithSchema = sourceCell.asSchema<{
          argument?: unknown;
          internal?: unknown;
        }>(true as any);
        await sourceCellWithSchema.sync();
        const sourceValue = sourceCellWithSchema.get();

        console.log(
          "[discoverLinks] Source cell value keys:",
          sourceValue && typeof sourceValue === "object"
            ? Object.keys(sourceValue)
            : "not object",
        );

        if (sourceValue && typeof sourceValue === "object") {
          // Traverse argument if present
          if ("argument" in sourceValue && sourceValue.argument !== undefined) {
            console.log("[discoverLinks] Traversing argument");
            const argumentLinks = discoverLinksFromValue(sourceValue.argument);
            console.log(
              "[discoverLinks] Links from argument:",
              argumentLinks.length,
            );
            allLinks.push(...argumentLinks);
          }

          // Traverse internal if present
          if ("internal" in sourceValue && sourceValue.internal !== undefined) {
            console.log("[discoverLinks] Traversing internal");
            const internalLinks = discoverLinksFromValue(sourceValue.internal);
            console.log(
              "[discoverLinks] Links from internal:",
              internalLinks.length,
            );
            allLinks.push(...internalLinks);
          }
        }
      } else {
        console.log("[discoverLinks] No source cell (not a pattern result)");
      }
    } catch (e) {
      console.log("[discoverLinks] Error getting source cell:", e);
    }

    // Deduplicate links by (space, id)
    const linkKey = (link: DiscoveredLink) =>
      `${link.link.space}:${link.link.id}`;
    const seen = new Set<string>();
    const uniqueLinks = allLinks.filter((link) => {
      const key = linkKey(link);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Resolve each link and filter to only navigable pieces (those with $NAME)
    const resolvedLinks = await Promise.all(
      uniqueLinks.map(async (link) => {
        const result = await resolveAndCheckNavigable(link.cellHandle);
        console.log(
          `[discoverLinks] Link ${link.link.id.slice(0, 30)}... resolved to ${
            result.resolvedLink.id.slice(0, 30)
          }... isNavigable: ${result.isNavigable}`,
        );
        // Return a new DiscoveredLink with the RESOLVED cell info
        return {
          original: link,
          resolved: {
            link: result.resolvedLink,
            path: link.path,
            cellHandle: result.resolvedCell,
          } as DiscoveredLink,
          isNavigable: result.isNavigable,
        };
      }),
    );

    console.log(
      `[discoverLinks] After navigable filter: ${
        resolvedLinks.filter((c) => c.isNavigable).length
      } of ${resolvedLinks.length}`,
    );

    // Deduplicate again by resolved ID (different paths may resolve to same cell)
    const resolvedSeen = new Set<string>();
    this.links = resolvedLinks
      .filter((check) => check.isNavigable)
      .filter((check) => {
        const key = `${check.resolved.link.space}:${check.resolved.link.id}`;
        if (resolvedSeen.has(key)) return false;
        resolvedSeen.add(key);
        return true;
      })
      .map((check) => check.resolved);

    this.host.requestUpdate();
  }

  hostConnected(): void {
    // No-op: binding is done explicitly via bind()
  }

  hostDisconnected(): void {
    // Clean up subscription when host is disconnected
    this.unbind();
  }
}

// Re-export the type for convenience
export type { DiscoveredLink };
