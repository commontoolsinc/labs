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
@customElement('mutation-log-entry')
export class MutationLogEntry extends LitElement {
  @property({ attribute: false }) accessor mutation: any;

  static override styles = css`
    :host {
      display: block;
      font-family: monospace;
      font-size: 12px;
      margin: 4px 0;
    }

    .log-line {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .assert { color: #27ae60; }
    .upsert { color: #f1c40f; }
    .retract { color: #e74c3c; }

    .details-btn {
      opacity: 0.5;
      cursor: pointer;
      font-size: 10px;
      background: none;
      border: none;
      padding: 2px;
    }

    .details-btn:hover {
      opacity: 1;
    }

    span {
      color: #333333;
    }
  `;

  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return '[...]';
    if (typeof value === 'object') return '{...}';
    if (typeof value === 'string') return `'${value}'`;
    return String(value);
  }

  private showDetails() {
    console.group('Mutation Details');
    console.log('%cRule:', 'color: #3498db', this.mutation.rule);
    console.log('%cRevision:', 'color: #3498db', this.mutation.revision);
    console.log('%cSelection:', 'color: #3498db', this.mutation.selection);
    console.log('%cChanges:', 'color: #3498db', this.mutation.changes);
    console.groupEnd();
  }

  override render() {
    const changes = this.mutation.changes;
    let icon = '';
    let colorClass = '';

    // Handle array of changes
    const change = changes[0];
    const type = Object.keys(change)[0];
    const [_, field, value] = change[type];

    const formatValue = (val: any) => {
      const formatted = this.formatValue(val);
      if (typeof val === 'string' && val.length > 32) {
        const start = formatted.slice(0, 16);
        const end = formatted.slice(-16);
        return `${start}…${end}`;
      }
      return formatted;
    };

    if (type === 'Assert') {
      icon = '+';
      colorClass = 'assert';
    } else if (type === 'Upsert') {
      icon = '~';
      colorClass = 'upsert';
    } else if (type === 'Retract') {
      icon = '-';
      colorClass = 'retract';
    }

    return html`
      <div class="log-line">
        <span class=${colorClass}><b>${icon}</b></span>
        <span><b>${field}</b>= ${field === '~/common/ui' ? 're-render' : formatValue(value)}</span>
        <button class="details-btn" @click=${this.showDetails} title="Show full details">🔍</button>
      </div>
    `;
  }
}


@customElement('rule-details-popover')
export class RuleDetailsPopover extends LitElement {
  @property({ attribute: false }) accessor rule: string = '';
  @property({ attribute: false }) accessor color: string = '#000';
  @property({ attribute: false }) accessor activation: any = null;
  @property({ attribute: false }) accessor ruleData: any = null;

  static override styles = css`
    :host {
      position: absolute;
      left: -320px;
      top: 0;
      width: 300px;
      max-height: 320px;
      background: white;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      overflow-y: auto;
      font-size: 14px;
      pointer-events: all;
    }

    pre {
      background: rgba(0,0,0,0.1);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
    }

    .close {
      position: absolute;
      right: 8px;
      top: 8px;
      cursor: pointer;
      opacity: 0.6;
    }

    .close:hover {
      opacity: 1;
    }
  `;

  override render() {
    return html`
      <div style="color: ${this.color}">
        <div class="close" @click=${() => this.remove()}>✕</div>
        <h3>${this.rule}</h3>
        <div>Activations: ${this.activation?.count || 0}</div>
        ${this.activation?.performanceMs ? html`
          <div>Last performance: ${this.activation.performanceMs}ms</div>
        ` : ''}

        <h4>Rule Definition</h4>
        <pre>${JSON.stringify(this.ruleData, null, 2)}</pre>

        ${this.activation?.lastSelection ? html`
          <h4>Last Selection</h4>
          <pre>${JSON.stringify(this.activation.lastSelection, null, 2)}</pre>
        ` : ''}
      </div>
    `;
  }
}


@customElement('charm-debugger')
export class CharmDebugger extends LitElement {
  private _entity: Reference | null = null;
  private _behavior: Behavior | null = null;
  private activePopover: RuleDetailsPopover | null = null;

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
  private pulsingRules: Set<string> = new Set();

  private getColorForEntity(entityId: string): string {
    const hash = Array.from(entityId).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return this.cardColors[hash % this.cardColors.length];
  }

  private showRuleDetails(rule: string, color: string, activation: any, ruleData: any) {
    // Remove any existing popover
    this.activePopover?.remove();

    const popover = document.createElement('rule-details-popover') as RuleDetailsPopover;
    popover.rule = rule;
    popover.color = color;
    popover.activation = activation;
    popover.ruleData = ruleData;
    this.activePopover = popover;
    this.renderRoot.appendChild(popover);
  }

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
      overflow: visible;
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      align-items: flex-end;
    }

    .content * {
      pointer-events: auto;
    }

    :host(.closed) .content > .rules-grid {
      display: none;
    }

    :host(.mutation-log-closed) .content > .mutation-log {
      display: none;
    }

    .rules-grid {
      position: relative;
      right: 16px;
      top: 16px;
      max-width: 128px;
      pointer-events: all;
      min-height: 256px;
      box-sizing: border-box;
      padding: 32px 16px;
      overflow: visible;
      transform: scale(0.75);
      opacity: 0.75;
      transform-origin: top right;
      transition: transform 0.2s ease-in-out, opacity 0.2s ease-in-out;
    }

    .rules-grid:hover {
      transform: scale(1);
      opacity: 1;
    }

    .rule-item {
      position: absolute;
      width: 48%;
      transition: all 0.3s ease;
    }

    .rule-item:nth-child(odd) {
      left: 0;
    }

    .rule-item:nth-child(even) {
      right: 0;
      margin-top: 48px;
    }

    .emoji-tile {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      border-radius: 128px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      cursor: pointer;
      border: 2px solid white;
      transition: transform 0.2s ease;
      transform: scale(1.2);
      opacity: 0.9;
    }

    .emoji-tile:hover {
      transform: scale(1.3) rotate(5deg);
      opacity: 1;
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

    .mutation-log {
      background: white;
      border-radius: 8px;
      padding: 12px;
      margin-top: 16px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    @keyframes pulse {
      0% { transform: scale(1.2); }
      50% { transform: scale(1.3); opacity: 1; }
      100% { transform: scale(1.2); }
    }

    .pulse {
      animation: pulse 0.3s ease-in-out;
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

        this.pulsingRules.add(ruleName);
        setTimeout(() => {
          this.pulsingRules.delete(ruleName);
          this.requestUpdate();
        }, 300);

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
              style="background: ${this.getColorForEntity(this.entity.toString())};"
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
          <div class="rules-grid">
            ${Object.keys(this.behavior.rules).map((rule, index) => {
              const hash = Array.from(rule).reduce((acc, char) => acc + char.charCodeAt(0), 0);
              const emojiList = ["🌟", "🎯", "🎨", "🎭", "🎪", "🎢", "🎡", "🎮", "🎲", "🎰", "🎳", "🎹", "🎼", "🎧", "🎤", "🎬", "🎨", "🎭", "🎪"];
              const activation = this.ruleActivations.get(rule);
              const emoji = emojiList[hash % emojiList.length];
              const color = this.cardColors[hash % this.cardColors.length];

              return html`
                <div class="rule-item" style="top: ${Math.floor(index / 2) * 96}px">
                  <div
                    class="emoji-tile ${this.pulsingRules.has(rule) ? 'pulse' : ''}"
                    style="background: ${color}"
                    title="${rule} (${activation?.count || 0} activations)"
                    @click=${() => this.showRuleDetails(rule, color, activation, this.behavior?.rules[rule])}
                  >
                    ${emoji}
                  </div>
                </div>
              `;
            })}
          </div>
        ` : ''}

        <div class="mutation-log">
          <div style="font-weight: bold;">Mutation Log</div>
          ${this.mutationLog.map(mutation => html`
            <mutation-log-entry .mutation=${mutation}></mutation-log-entry>
          `)}
        </div>
      </div>
    `;
  }
}
