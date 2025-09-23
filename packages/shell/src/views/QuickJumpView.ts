import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseView } from "./BaseView.ts";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Task } from "@lit/task";
import { CharmController } from "@commontools/charm/ops";
import { charmId } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { NAME } from "@commontools/runner";
import { navigate } from "../lib/navigate.ts";

type CharmItem = { id: string; name: string };

export class XQuickJumpView extends BaseView {
  static override styles = css`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }

    :host([visible]) {
      display: flex;
    }

    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.3);
    }

    .panel {
      position: relative;
      width: min(720px, 90vw);
      background: #fff;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .input {
      padding: 10px 12px;
      border: 0;
      border-bottom: var(--border-width, 2px) solid var(--border-color, #000);
      outline: none;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
    }

    .list {
      max-height: 300px;
      overflow: auto;
      padding: 6px 0;
      margin: 0;
      list-style: none;
    }

    .item {
      padding: 8px 12px;
      cursor: pointer;
      display: flex;
      gap: 8px;
      align-items: baseline;
    }

    .item[aria-selected="true"] {
      background: #f0f4ff;
    }
    .item:hover {
      background: #f0f4ff;
    }

    .name {
      flex: 1;
      color: var(--text-primary, #000);
    }

    .id {
      color: #666;
      font-size: 12px;
    }
  `;

  @property({ type: Boolean, reflect: true })
  visible = false;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @state()
  private query = "";

  @state()
  private selectedIndex = 0;

  private inputEl?: HTMLInputElement | null;
  private charmListSubscription?: CellEventTarget<Cell<unknown>[]>;
  private nameSubscriptions: Map<string, CellEventTarget<string | undefined>> =
    new Map();

  private _charms = new Task(this, {
    task: async ([rt]) => {
      if (!rt) return undefined;
      const manager = rt.cc().manager();
      await manager.synced();
      return rt.cc().getAllCharms();
    },
    args: () => [this.rt],
  });

  override updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (changed.has("rt")) {
      this.teardownSubscriptions();
      this.setupSubscriptions();
    }
    if (changed.has("visible") && this.visible) {
      // Focus input when opened
      this.updateComplete.then(() => {
        this.inputEl = this.renderRoot.querySelector("input.input");
        this.inputEl?.focus();
        this.inputEl?.select();
      });
    }
  }

  private setupSubscriptions() {
    const rt = this.rt;
    if (!rt) return;
    const charmsCell = rt.cc().manager().getCharms();
    this.charmListSubscription = new CellEventTarget(charmsCell);
    this.charmListSubscription.addEventListener(
      "update",
      this.onCharmListUpdate,
    );
    // Initialize name subscriptions with current list
    try {
      const list = charmsCell.get();
      this.resetNameSubscriptions(list);
    } catch {
      // ignore
    }
  }

  private teardownSubscriptions() {
    if (this.charmListSubscription) {
      this.charmListSubscription.removeEventListener(
        "update",
        this.onCharmListUpdate,
      );
      this.charmListSubscription = undefined;
    }
    for (const [_, target] of this.nameSubscriptions) {
      target.removeEventListener("update", this.onCharmNameUpdate);
    }
    this.nameSubscriptions.clear();
  }

  private onCharmListUpdate = (e: Event) => {
    const event = e as CellUpdateEvent<readonly Cell<any>[]>;
    const list = event.detail ?? [];
    this.resetNameSubscriptions(list);
    // Rebuild controllers list used by getItems
    this._charms.run();
  };

  private resetNameSubscriptions(list: readonly Cell<any>[]) {
    // Remove old
    for (const [_, target] of this.nameSubscriptions) {
      target.removeEventListener("update", this.onCharmNameUpdate);
    }
    this.nameSubscriptions.clear();

    // Add new
    for (const c of list) {
      const id = charmId(c as Cell<any>);
      if (!id) continue;
      const nameCell = (c as Cell<any>).key(NAME) as Cell<string | undefined>;
      const target = new CellEventTarget(nameCell);
      target.addEventListener("update", this.onCharmNameUpdate);
      this.nameSubscriptions.set(id, target);
    }
  }

  private onCharmNameUpdate = (_e: Event) => {
    // Any name change should refresh render so c.name() reflects latest value
    this.requestUpdate();
  };

  private close() {
    this.query = "";
    this.selectedIndex = 0;
    this.command({ type: "set-show-quick-jump-view", show: false });
  }

  private getItems(): CharmItem[] {
    const list = this._charms.value || [];
    return list.map((c: CharmController) => ({
      id: c.id,
      name: c.name() ?? "Untitled Charm",
    }));
  }

  private containsInsensitive(a: string, b: string): boolean {
    return a.toLowerCase().includes(b.toLowerCase());
  }

  private score(item: CharmItem, q: string): number {
    if (!q) return 0;
    const n = item.name.toLowerCase();
    const i = item.id.toLowerCase();
    const ql = q.toLowerCase();
    let s = 0;
    if (n === ql) s += 1000;
    if (n.startsWith(ql)) s += 500;
    if (this.containsInsensitive(n, ql)) s += 200;
    if (this.containsInsensitive(i, ql)) s += 100;
    // simple subsequence bonus
    let qi = 0;
    for (let ni = 0; ni < n.length && qi < ql.length; ni++) {
      if (n[ni] === ql[qi]) qi++;
    }
    if (qi === ql.length) s += 50;
    return s;
  }

  private filtered(): CharmItem[] {
    const items = this.getItems();
    const q = this.query.trim();
    if (!q) return items.slice(0, 20);
    return items
      .map((it) => ({ it, s: this.score(it, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .map((x) => x.it);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.visible) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    const results = this.filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(
        results.length - 1,
        this.selectedIndex + 1,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = results[this.selectedIndex];
      if (sel) this.navigateTo(sel.id);
    }
  };

  private onInput = (e: Event) => {
    const t = e.target as HTMLInputElement;
    this.query = t.value;
    this.selectedIndex = 0;
  };

  private onClickBackdrop = (e: Event) => {
    e.preventDefault();
    this.close();
  };

  private onClickItem = (id: string) => {
    this.navigateTo(id);
  };

  private navigateTo(id: string) {
    const spaceName = this.rt?.cc().manager().getSpaceName();
    if (!spaceName) return;
    navigate({ type: "charm", spaceName, charmId: id });
    this.close();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.onKeyDown);
    this.setupSubscriptions();
  }

  override disconnectedCallback(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.teardownSubscriptions();
    super.disconnectedCallback();
  }

  override render() {
    if (!this.visible) {
      return html`

      `;
    }
    const results = this.filtered();
    const selected = this.selectedIndex;
    return html`
      <div class="backdrop" @click="${this.onClickBackdrop}"></div>
      <div class="panel">
        <input
          class="input"
          type="text"
          placeholder="Jump to charm…"
          .value="${this.query}"
          @input="${this.onInput}"
        />
        <ul class="list" role="listbox">
          ${results.map((r, idx) =>
            html`
              <li
                class="item"
                role="option"
                aria-selected="${idx === selected}"
                @mouseenter="${() => {
                  this.selectedIndex = idx;
                }}"
                @click="${() => this.onClickItem(r.id)}"
              >
                <div class="name">${r.name}</div>
                <div class="id">${r.id}</div>
              </li>
            `
          )} ${results.length === 0
            ? html`
              <li class="item"><div class="name">No matches</div></li>
            `
            : ""}
        </ul>
      </div>
    `;
  }
}

globalThis.customElements.define("x-quick-jump-view", XQuickJumpView);
