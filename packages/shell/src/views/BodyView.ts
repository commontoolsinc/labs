import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { Task } from "@lit/task";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/OmniLayout.ts";
import { CellHandle, PageHandle, VNode } from "@commonfabric/runtime-client";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import type { JSONSchema } from "@commonfabric/runner/shared";

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
      padding: 0 1.5rem;
      box-sizing: border-box;
    }

    .content.embedded {
      padding: 0;
    }

    @media (max-width: 768px) {
      .content {
        padding: 1rem;
      }

      .content.embedded {
        padding: 0;
      }
    }

    x-omni-layout {
      flex: 1;
    }

    cf-piece,
    cf-render[slot="main"] {
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
  `;

  @property({ attribute: false })
  accessor rt: RuntimeInternals | undefined = undefined;

  @property({ attribute: false })
  accessor activePattern: PageHandle | undefined = undefined;

  @property({ attribute: false })
  accessor spaceRootPattern: PageHandle | undefined = undefined;

  @property()
  accessor showShellPieceListView = false;

  @property({ type: Boolean })
  accessor showSidebar = false;

  @property({ attribute: false })
  accessor patternError: Error | undefined = undefined;

  @property({ type: Boolean })
  accessor embedded = false;

  private _subPages = new Task(this, {
    task: async ([activePattern, spaceRootPattern, embedded]) => {
      if (embedded) {
        return {
          sidebarUI: undefined,
          fabUI: undefined,
        };
      }
      const [sidebarUI, fabUI] = await Promise.all([
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
    args: () => [this.activePattern, this.spaceRootPattern, this.embedded],
  });

  override render() {
    // Show error if pattern failed to start
    const mainContent = this.patternError
      ? html`
        <div slot="main" class="pattern-error">
          <h2>Failed to load piece</h2>
          <p>${this.patternError.message}</p>
        </div>
      `
      : this.activePattern
      ? html`
        <cf-piece slot="main" .pieceId="${this.activePattern.id()}">
          <cf-render .cell="${this.activePattern.cell()}"></cf-render>
        </cf-piece>
      `
      : null;

    const sidebar = this.embedded
      ? undefined
      : this._subPages?.value?.sidebarUI;
    const fab = this.embedded ? undefined : this._subPages?.value?.fabUI;

    return html`
      <div class="content ${this.embedded ? "embedded" : ""}">
        <x-omni-layout .sidebarOpen="${!this.embedded && this.showSidebar}">
          ${mainContent} ${sidebar
            ? html`
              <cf-render slot="sidebar" .cell="${sidebar}"></cf-render>
            `
            : null} ${fab
            ? html`
              <cf-render slot="fab" .cell="${fab}"></cf-render>
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
