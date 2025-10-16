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

    common-charm,
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

  @state()
  private creatingDefaultPattern = false;

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
    const defaultPattern = charms
      ? DefaultPattern.getDefaultPattern(charms)
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

    if (!defaultPattern) {
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

    const defaultCell = defaultPattern.getCell();
    const activeCharm = this.activeCharm;

    const mainContent = activeCharm
      ? html`
        <common-charm slot="main" .charmId="${activeCharm.id}">
          <ct-render .cell="${activeCharm.getCell()}"></ct-render>
        </common-charm>
      `
      : html`
        <ct-render slot="main" .cell="${defaultCell}"></ct-render>
      `;

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

    return html`
      <div class="content">
        <x-omni-layout>
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

    return defaultCell ? defaultCell.key(key as never) : undefined;
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
