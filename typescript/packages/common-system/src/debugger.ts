import { Reference } from "./db.js";
import { Behavior } from "./adapter.js";
import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

function setDebugCharms(value: boolean) {
  (globalThis as any).DEBUG_CHARMS = value;
}

export function getDebugCharms(): boolean {
  return (globalThis as any).DEBUG_CHARMS;
}

setDebugCharms(true);

export function truncateId(id: string | Reference) {
  if (typeof id === "object") id = id.toString();

  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

@customElement('charm-debugger')
export class CharmDebugger extends LitElement {
  private _entity: Reference | null = null;
  private _behavior: Behavior | null = null;

  @property({ attribute: false })
  get entity() {
    return this._entity;
  }
  set entity(value: Reference | null) {
    this._entity = value;
    this.requestUpdate();
  }

  @property({ attribute: false })
  get behavior() {
    return this._behavior;
  }
  set behavior(value: Behavior | null) {
    this._behavior = value;
    this.requestUpdate();
  }

  private ruleActivations: Map<
    string,
    { count: number; lastSelection: any; performanceMs: number }
  > = new Map();

  private cardColors = [
    "#ff7675",
    "#74b9ff",
    "#55efc4",
    "#ffeaa7",
    "#b2bec3",
    "#fd79a8",
    "#81ecec",
  ];

  private mutationLog: any[] = [];
  private isOpen: boolean = false;
  private isMutationLogOpen: boolean = false;

  static override styles = css`
    :host {
      position: absolute;
      top: 4px;
      right: 4px;
      min-width: 64px;
      width: 20%;
      max-height: 512px;
      overflow-y: auto;
      font-size: 16px;
      font-family: monospace;
      color: black;
      pointer-events: none;
    }

    .content * {
      pointer-events: auto;
    }

    :host(.closed) .content > ul {
      display: none;
    }

    :host(.mutation-log-closed) .content > .mutation-log {
      display: none;
    }

    ul {
      list-style: none;
      padding: 0;
    }

    details {
      margin-bottom: 8px;
      border-radius: 8px;
      padding: 8px;
    }

    summary {
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
    }

    .entity-id {
      padding: 4px 8px;
      border-radius: 16px;
      display: inline-block;
      margin-bottom: 4px;
      cursor: pointer;
      font-size: 8px;
    }

    .mutation-log-toggle {
      padding: 4px 8px;
      border-radius: 16px;
      display: inline-block;
      margin-bottom: 4px;
      cursor: pointer;
      margin-left: 4px;
      font-size: 8px;
    }

    .explanation {
      font-style: italic;
      font-size: 14px;
    }

    .performance {
      font-size: 11px;
    }

    pre {
      background: rgba(0,0,0,0.5);
      color: white;
      padding: 12px;
      border-radius: 4px;
      font-size: 14px;
      overflow-x: auto;
    }

    .rule-card {
      border-radius: 16px;
      margin-bottom: 8px;
      padding: 4px;
      padding-left: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      font-size: 12px;
    }

    .mutation-log {
      background: white;
      border-radius: 8px;
      padding: 12px;
      margin-top: 16px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .mutation-log summary {
      font-size: 14px;
    }

    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); }
    }

    .pulse {
      animation: pulse 0.3s ease-in-out;
    }

    img {
      width: 100%;
      max-width: 128px;
      max-height: 128px;
      border-radius: 50%;
      margin: 8px 0;
      border: 2px solid white;
    }

    .copy-button {
      padding: 2px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 8px;
      margin-left: 2px;
      background: transparent;
      border: none;
      opacity: 0.6;
      position: relative;
      top: -2px;
    }

    .copy-button:hover {
      opacity: 1;
    }
  `;

  constructor() {
    super();

    window.addEventListener("query-triggered", (event: any) => {
      if (
        event.detail.entity === this.entity?.toString() &&
        event.detail.spell == this.behavior?.id.toString()
      ) {
        const ruleName = event.detail.rule;
        const current = this.ruleActivations.get(ruleName) || {
          count: 0,
          lastSelection: null,
        };

        this.ruleActivations.set(ruleName, {
          count: current.count + 1,
          lastSelection: event.detail.match,
          performanceMs: event.detail.performanceMs,
        });

        this.requestUpdate();
      }
    });

    window.addEventListener("mutation", (event: any) => {
      if (
        event.detail.entity === this.entity?.toString() &&
        event.detail.spell === this.behavior?.id.toString()
      ) {
        this.mutationLog.push(event.detail);
        this.requestUpdate();
      }
    });

    if (!this.isOpen) {
      this.classList.add("closed");
    }
    if (!this.isMutationLogOpen) {
      this.classList.add("mutation-log-closed");
    }
  }

  toggleOpen() {
    this.isOpen = !this.isOpen;
    this.classList.toggle("closed");
  }

  toggleMutationLog() {
    this.isMutationLogOpen = !this.isMutationLogOpen;
    this.classList.toggle("mutation-log-closed");
  }

  override render() {
    return html`
      <div class="content">
        ${this.entity ? html`
          <div>
            <div
              class="entity-id"
              style="background: ${this.cardColors[Math.floor(Math.random() * this.cardColors.length)]};"
              title=${this.entity.toString()}
              @click=${this.toggleOpen}
            >
              ${truncateId(this.entity)}
            </div>
            <button class="copy-button" title="Copy ID" @click=${(e: Event) => {
              e.stopPropagation();
              navigator.clipboard.writeText(this.entity!.toString());
            }}>📋</button>
            <button class="copy-button" title="Toggle Log" @click=${this.toggleMutationLog}>📜</button>
          </div>
        ` : ''}

        ${this.behavior?.rules ? html`
          <ul>
            ${Object.keys(this.behavior.rules).map(rule => {
              const hash = Array.from(rule).reduce((acc, char) => acc + char.charCodeAt(0), 0);
              const emojiList = ["🌟", "🎯", "🎨", "🎭", "🎪", "🎢", "🎡", "🎮", "🎲", "🎰", "🎳", "🎹", "🎼", "🎧", "🎤", "🎬", "🎨", "🎭", "🎪"];
              const activation = this.ruleActivations.get(rule);

              return html`
                <li>
                  <details class="rule-card" data-rule=${rule} style="background: ${this.cardColors[hash % this.cardColors.length]}">
                    <summary>${rule} ${emojiList[hash % emojiList.length]} (${activation?.count || 0})</summary>
                    ${activation?.lastSelection ? html`
                      <pre>${JSON.stringify(activation.lastSelection, null, 2)}</pre>
                    ` : ''}
                    <div class="explanation">Rule:</div>
                    <pre>${JSON.stringify(this.behavior!.rules[rule], null, 2)}</pre>
                    <div class="performance">${activation?.performanceMs || 0}ms</div>
                  </details>
                </li>
              `;
            })}
          </ul>
        ` : ''}

        <div class="mutation-log">
          <div style="font-weight: bold;">Mutation Log</div>
          ${this.mutationLog.map(mutation => html`
            <details>
              <summary title="${mutation.rule}@${mutation.revision}">
                ${mutation.rule}@${truncateId(mutation.revision)}
              </summary>

              <div class="explanation">${mutation.explanation}</div>

              <details>
                <summary style="font-weight: bold;">Selection</summary>
                <pre>${JSON.stringify(mutation.selection, null, 2)}</pre>
              </details>

              <details>
                <summary style="font-weight: bold;">Changes</summary>
                <pre>${JSON.stringify(mutation.changes, null, 2)}</pre>
              </details>
            </details>
          `)}
        </div>
      </div>
    `;
  }
}
