import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { Task } from "@lit/task";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/OmniLayout.ts";
import { CellHandle, PageHandle, VNode } from "@commontools/runtime-client";
import { rendererVDOMSchema } from "@commontools/runner/schemas";
import type { JSONSchema } from "@commontools/runner/shared";

type SubPages = {
  sidebarUI?: VNode;
  fabUI?: VNode;
};

const SubPagesSchema = {
  type: "object",
  properties: {
    sidebarUI: { $ref: "#/$defs/vdomNode" },
    fabUI: { $ref: "#/$defs/vdomNode" },
  },
  $defs: {
    ...rendererVDOMSchema.$defs,
  },
} as const satisfies JSONSchema;

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

    .pattern-error {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      color: #c00;
      text-align: center;
    }

    .pattern-error h2 {
      margin: 0 0 1rem;
    }

    .pattern-error p {
      margin: 0;
      font-family: monospace;
    }

    v-box {
      flex: 1;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @property({ attribute: false })
  activePattern?: PageHandle;

  @property({ attribute: false })
  spaceRootPattern?: PageHandle;

  @property()
  showShellCharmListView = false;

  @property({ type: Boolean })
  showSidebar = false;

  @property({ attribute: false })
  patternError?: Error;

  private _subPages = new Task(this, {
    task: async ([activePattern, spaceRootPattern]) => {
      const [
        sidebarUI,
        fabUI,
      ] = await Promise.all([
        getSubPageCell(
          activePattern?.cell() as CellHandle<SubPages> | undefined,
          "sidebarUI",
        ),
        getSubPageCell(
          spaceRootPattern?.cell() as CellHandle<SubPages> | undefined,
          "fabUI",
        ),
      ]);
      return {
        sidebarUI,
        fabUI,
      };
    },
    args: () => [this.activePattern, this.spaceRootPattern],
  });

  override render() {
    // Show error if pattern failed to start
    const mainContent = this.patternError
      ? html`
        <div slot="main" class="pattern-error">
          <h2>Failed to load charm</h2>
          <p>${this.patternError.message}</p>
        </div>
      `
      : this.activePattern
      ? html`
        <ct-charm slot="main" .pieceId="${this.activePattern.id()}">
          <ct-render .cell="${this.activePattern.cell()}"></ct-render>
        </ct-charm>
      `
      : null;

    const sidebar = this._subPages?.value?.sidebarUI;
    const fab = this._subPages?.value?.fabUI;

    return html`
      <div class="content">
        <x-omni-layout .sidebarOpen="${this.showSidebar}">
          ${mainContent} ${sidebar
            ? html`
              <ct-render slot="sidebar" .cell="${sidebar}"></ct-render>
            `
            : null} ${fab
            ? html`
              <ct-render slot="fab" .cell="${fab}"></ct-render>
            `
            : null}
        </x-omni-layout>
      </div>
    `;
  }
}

globalThis.customElements.define("x-body-view", XBodyView);

async function getSubPageCell(
  cell: CellHandle<SubPages> | undefined,
  key: "fabUI" | "sidebarUI",
): Promise<CellHandle<VNode> | undefined> {
  if (!cell) return undefined;
  const typedCell = cell.asSchema<SubPages>(SubPagesSchema);
  let value = typedCell.get();
  if (!value) {
    await typedCell.sync();
    value = typedCell.get();
    if (!value) {
      return;
    }
  }
  if (key in value && value[key]) {
    return typedCell.key(key).asSchema<VNode>(rendererVDOMSchema);
  }
}
