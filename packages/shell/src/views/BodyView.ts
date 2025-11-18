import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { CharmController } from "@commontools/charm/ops";
import * as DefaultPattern from "../lib/default-pattern.ts";
import { isVNode } from "@commontools/html";
import { UI } from "@commontools/runner";
import type { Cell } from "@commontools/runner";
import "../components/OmniLayout.ts";

export class XBodyView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 1rem;
      box-sizing: border-box;
    }

    x-omni-layout {
      flex: 1;
    }

    ct-charm,
    ct-render[slot="main"] {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    v-box {
      flex: 1;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activeCharm?: CharmController;

  @property()
  showShellCharmListView = false;

  @property({ type: Boolean })
  showSidebar = false;

  @state()
  private creatingDefaultPattern = false;

  @state()
  private hasSidebarContent = false;

  private _charms = new Task(this, {
    task: async ([rt]) => {
      if (!rt) return undefined;

      const manager = rt.cc().manager();
      await manager.synced();
      return rt.cc().getAllCharms();
    },
    args: () => [this.rt],
  });

  async onRequestDefaultPattern(e: Event) {
    e.preventDefault();
    if (this.creatingDefaultPattern || !this.rt) {
      return;
    }

    this.creatingDefaultPattern = true;
    try {
      await DefaultPattern.create(this.rt.cc());
    } catch (error) {
      console.error("Could not create default pattern:", error);
      // Re-throw to expose errors instead of swallowing them
      throw error;
    } finally {
      this.creatingDefaultPattern = false;
      this._charms.run();
    }
  }

  override render() {
    const charms = this._charms.value;
    const spaceName = this.rt
      ? this.rt.cc().manager().getSpaceName()
      : undefined;
    if (!charms) {
      return html`
        <div class="content">
          <x-spinner></x-spinner>
        </div>
      `;
    }

    if (this.showShellCharmListView) {
      return html`
        <div class="content">
          <x-charm-list-view
            .charms="${charms}"
            .spaceName="${spaceName}"
            .rt="${this.rt}"
            @charm-removed="${() => this._charms.run()}"
          ></x-charm-list-view>
        </div>
      `;
    }

    const defaultPattern = charms
      ? DefaultPattern.getDefaultPattern(charms)
      : undefined;
    const activeCharm = this.activeCharm;

    if (!defaultPattern && !activeCharm) {
      return this.creatingDefaultPattern
        ? html`
          <div class="content">
            <v-box center="${true}">
              <div>Creating default pattern...</div>
              <x-spinner></x-spinner>
            </v-box>
          </div>
        `
        : html`
          <div class="content">
            <v-box center="${true}">
              <div>Create default pattern?</div>
              <x-button
                variant="primary"
                @click="${this.onRequestDefaultPattern}"
              >
                Go!
              </x-button>
            </v-box>
          </div>
        `;
    }

    const defaultCell = defaultPattern?.getCell();

    const mainContent = activeCharm
      ? html`
        <ct-charm slot="main" .charmId="${activeCharm.id}">
          <ct-render .cell="${activeCharm.getCell()}"></ct-render>
        </ct-charm>
      `
      : defaultCell
      ? html`
        <ct-render slot="main" .cell="${defaultCell}"></ct-render>
      `
      : null;

    const sidebarCell = this._selectSlotCell(
      activeCharm,
      "sidebarUI",
      defaultCell,
    );
    const fabCell = this._selectSlotCell(
      activeCharm,
      "fabUI",
      defaultCell,
    );

    // Update sidebar content detection
    const hasSidebarContent = !!sidebarCell;
    if (this.hasSidebarContent !== hasSidebarContent) {
      this.hasSidebarContent = hasSidebarContent;
      // Notify parent of sidebar content changes
      this.dispatchEvent(
        new CustomEvent("sidebar-content-change", {
          detail: { hasSidebarContent },
          bubbles: true,
          composed: true,
        }),
      );
    }

    return html`
      <div class="content">
        <x-omni-layout .sidebarOpen="${this.showSidebar}">
          ${mainContent} ${sidebarCell
            ? html`
              <ct-render slot="sidebar" .cell="${sidebarCell}"></ct-render>
            `
            : null} ${fabCell
            ? html`
              <ct-render slot="fab" .cell="${fabCell}"></ct-render>
            `
            : null}
        </x-omni-layout>
      </div>
    `;
  }

  private _selectSlotCell(
    charm: CharmController | undefined,
    key: string,
    defaultCell: Cell<unknown> | undefined,
  ): Cell<unknown> | undefined {
    if (charm) {
      const overrideCell = charm.getCell().key(key as never);
      if (this._cellHasRenderableUi(overrideCell)) {
        return overrideCell;
      }
    }

    if (!defaultCell) {
      return undefined;
    }

    const fallbackCell = defaultCell.key(key as never);
    return this._cellHasRenderableUi(fallbackCell) ? fallbackCell : undefined;
  }

  private _cellHasRenderableUi(cell: Cell<unknown>): boolean {
    const value = this._safeGetCellValue(cell);
    if (value === undefined) {
      return false;
    }

    if (isVNode(value)) {
      return true;
    }

    return typeof value === "object" && value !== null && UI in value;
  }

  private _safeGetCellValue(cell: Cell<unknown>): unknown {
    try {
      return cell.get();
    } catch (_error) {
      return undefined;
    }
  }
}

globalThis.customElements.define("x-body-view", XBodyView);
