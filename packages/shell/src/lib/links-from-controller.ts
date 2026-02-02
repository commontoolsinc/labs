import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { CellHandle } from "@commontools/runtime-client";
import {
  type DiscoveredLink,
  discoverLinksFromValue,
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

    this.cell = cell;

    // Subscribe to cell updates
    this.cancelSubscription = cell.subscribe((_value) => {
      // Re-discover links whenever the cell value changes
      this.discoverLinks();
    });

    // Perform initial discovery
    this.discoverLinks();
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
   * Triggers a host update if the links have changed.
   */
  private discoverLinks(): void {
    if (!this.cell) {
      this.links = [];
      return;
    }

    // Get the current value from the CellHandle
    const value = this.cell.get();
    if (value === undefined) {
      this.links = [];
      return;
    }

    // Discover links from the value (CellHandle instances are embedded in the value)
    this.links = discoverLinksFromValue(value);
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
