import { Behavior } from "./adapter.js";
import { html, css, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatDatalogQuery } from "./format.js";
import { explainQuery, explainMutation } from "./debug.js";
import { Reference } from "merkle-reference";

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
@customElement("entity-state-card")
export class EntityStateCard extends LitElement {
  @property({ attribute: false }) accessor entityId: string = "";
  @property({ attribute: false }) accessor state: Record<string, any> = {};

  static override styles = css`
    :host {
      display: block;
      font-family: monospace;
      font-size: 12px;
      padding: 8px;
      border-bottom: 1px solid #ddd;
    }

    .header {
      font-weight: bold;
      margin-bottom: 4px;
      color: #666;
    }

    .attribute-row {
      display: flex;
      gap: 8px;
      padding: 2px 0;
      align-items: center;
      white-space: nowrap;
    }

    .attribute-name {
      color: #333;
      min-width: 100px;
    }

    .attribute-value {
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }

    .inspect {
      opacity: 0.5;
      cursor: pointer;
      padding: 0 4px;
    }

    .inspect:hover {
      opacity: 1;
    }
  `;

  private inspectValue(key: string, value: any) {
    console.group(`Value for ${key}:`);
    console.log(value);
    console.groupEnd();
  }

  override render() {
    return html`
      <div class="header">${truncateId(this.entityId)}</div>
      ${Object.entries(this.state)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => {
          if (key.startsWith("~/common/")) return null;
          return html`
            <div class="attribute-row">
              <span class="attribute-name">${key}:</span>
              <span class="attribute-value">${JSON.stringify(value)}</span>
              <span
                class="inspect"
                @click=${() => this.inspectValue(key, value)}
                title="Inspect full value"
                >🔍</span
              >
            </div>
          `;
        })
        .filter(Boolean)}
    `;
  }
}

@customElement("mutation-log-entry")
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

    .assert {
      color: #27ae60;
    }
    .upsert {
      color: #f1c40f;
    }
    .retract {
      color: #e74c3c;
    }

    .details-btn {
      opacity: 0.5;
      cursor: pointer;
      font-size: 10px;
      background: none;
      border: none;
      padding: 2px;
      margin-left: auto;
    }

    .details-btn:hover {
      opacity: 1;
    }

    span {
      color: #333333;
    }
  `;

  private formatValue(value: any): string {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return "[...]";
    if (typeof value === "object") return "{...}";
    if (typeof value === "string") return `'${value}'`;
    return String(value);
  }

  private showDetails() {
    console.group("Mutation Details");
    console.log("%cRule:", "color: #3498db", this.mutation.rule);
    console.log("%cRevision:", "color: #3498db", this.mutation.revision);
    console.log("%cSelection:", "color: #3498db", this.mutation.selection);
    console.log("%cChanges:", "color: #3498db", this.mutation.changes);
    console.groupEnd();

    explainMutation(this.mutation)
      .then(explanation => {
        console.group("Mutation Explanation");
        console.log(explanation);
        console.groupEnd();
      })
      .catch(err => {
        console.error("Failed to explain mutation:", err);
      });
  }

  override render() {
    const changes = this.mutation.changes;
    const formatValue = (val: any) => {
      const formatted = this.formatValue(val);
      if (typeof val === "string" && val.length > 32) {
        const start = formatted.slice(0, 16);
        const end = formatted.slice(-16);
        return `${start}…${end}`;
      }
      return formatted;
    };

    if (changes.length === 0) {
      return html`
        <div class="log-line">
          <span><b>&lt;effect&gt;</b></span>
          <button
            class="details-btn"
            @click=${this.showDetails}
            title="Show full details"
          >
            🔍
          </button>
        </div>
      `;
    }

    return html`
      ${changes.map((change: any) => {
        let icon = "";
        let colorClass = "";
        let field;
        let value;

        if (change.Assert) {
          icon = "+";
          colorClass = "assert";
          [, field, value] = change.Assert;
        } else if (change.Upsert) {
          icon = "~";
          colorClass = "upsert";
          [, field, value] = change.Upsert;
        } else if (change.Retract) {
          icon = "-";
          colorClass = "retract";
          [, field, value] = change.Retract;
        }

        return html`
          <div class="log-line">
            <span class=${colorClass}><b>${icon}</b></span>
            <span>
              <b>${field}</b>=
              ${field === "~/common/ui" ? "re-render" : formatValue(value)}
            </span>
            <button
              class="details-btn"
              @click=${this.showDetails}
              title="Show full details"
            >
              🔍
            </button>
          </div>
        `;
      })}
    `;
  }
}

@customElement("rule-details-popover")
export class RuleDetailsPopover extends LitElement {
  @property({ attribute: false }) accessor rule: string = "";
  @property({ attribute: false }) accessor color: string = "#000";
  @property({ attribute: false }) accessor activation: any = null;
  @property({ attribute: false }) accessor behavior: Behavior;

  static override styles = css`
    :host {
      position: absolute;
      left: -320px;
      top: 0;
      width: 300px;
      max-height: 320px;
      background: #f8f9fa;
      border-radius: 4px;
      padding: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      overflow-y: auto;
      font-size: 12px;
      pointer-events: all;
      font-family: monospace;
      border: 1px solid #dee2e6;
    }

    pre {
      background: white;
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      border: 1px solid #dee2e6;
      margin: 4px 0;
    }

    .close {
      position: absolute;
      right: 8px;
      top: 8px;
      cursor: pointer;
      opacity: 0.6;
      font-family: system-ui;
    }

    .close:hover {
      opacity: 1;
    }

    .rule-controls {
      display: flex;
      gap: 8px;
      margin: 8px 0;
    }

    button {
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid #dee2e6;
      background: white;
    }

    button:hover {
      background: #f8f9fa;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .rule-name {
      font-weight: bold;
      font-size: 14px;
    }

    h4 {
      margin: 12px 0 4px 0;
      font-size: 12px;
      color: #666;
    }

    .stats {
      font-size: 11px;
      color: #666;
    }
  `;

  private enableRule() {
    const event = new CustomEvent("spell-rule-enabled", {
      detail: {
        id: this.behavior.id,
        name: this.rule,
      },
    });
    window.dispatchEvent(event);
  }

  private disableRule() {
    const event = new CustomEvent("spell-rule-disabled", {
      detail: {
        id: this.behavior.id,
        name: this.rule,
      },
    });
    window.dispatchEvent(event);
  }

  private async explainRule() {
    if (!this.behavior?.rules[this.rule]) return;

    const query = {
      select: this.behavior.rules[this.rule].select,
      where: [...this.behavior.rules[this.rule].where],
    };

    try {
      console.group(`Explanation for rule: ${this.rule}`);
      const explanation = await explainQuery(query);
      console.log(explanation);
      console.groupEnd();
    } catch (err) {
      console.error("Failed to explain query:", err);
    }
  }

  override render() {
    const style = getRuleStyle(this.rule) || { emoji: "🔧", color: this.color };

    return html`
      <div>
        <div class="close" @click=${() => this.remove()}>✕</div>
        <div class="header">
          <span style="color: ${style.color}; display: inline-block; width: 20px; height: 20px; border-radius: 50%; background-color: ${style.color}; text-align: center; line-height: 20px;">${style.emoji}</span>
          <span class="rule-name">${this.rule}</span>
        </div>

        <div class="rule-controls">
          <button @click=${this.enableRule}>Enable</button>
          <button @click=${this.disableRule}>Disable</button>
          <button @click=${this.explainRule}>Explain</button>
        </div>

        <div class="stats">
          <div>Activations: ${this.activation?.count || 0}</div>
          ${this.activation?.performanceMs
            ? html`
                <div>Last performance: ${this.activation.performanceMs}ms</div>
              `
            : ""}
        </div>

        <h4>Rule Definition</h4>
        <pre>
${formatDatalogQuery({
            select: this.behavior.rules[this.rule].select,
            where: [...this.behavior.rules[this.rule].where],
          })}</pre
        >

        ${this.activation?.lastSelection
          ? html`
              <h4>Last Selection</h4>
              <pre>
${JSON.stringify(this.activation.lastSelection, null, 2)}</pre
              >
            `
          : ""}
      </div>
    `;
  }
}

const cardColors = [
  "#ff7675",
  "#74b9ff",
  "#55efc4",
  "#ffeaa7",
  "#b2bec3",
  "#fd79a8",
  "#81ecec",
];

const rulePrefixes = new Map([
  ["likes/", { emoji: "👍", color: "#ffeaa7" }],
  ["description/", { emoji: "📝", color: "#ffffff" }],
  ["chat/", { emoji: "💬", color: "#74b9ff" }],
  ["comments/", { emoji: "✍️", color: "#fd79a8" }],
]);

function getColorForEntity(entityId: string): string {
  const hash = Array.from(entityId).reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0,
  );
  return cardColors[hash % cardColors.length];
}

function getRuleStyle(rule: string): { emoji: string; color: string } {
  // Check for event rules starting with 'on'
  if (/^on[A-Z]/.test(rule)) {
    return { emoji: "⚡", color: "#ffeaa7" };
  }

  // Check for view/render rules
  if (
    rule === "view" ||
    rule === "render" ||
    rule === "show" ||
    rule.startsWith("view") ||
    rule.startsWith("render") ||
    rule.startsWith("show")
  ) {
    return { emoji: "🎨", color: "#9b59b6" };
  }

  for (const [prefix, style] of rulePrefixes) {
    if (rule.startsWith(prefix)) {
      return style;
    }
  }

  const hash = Array.from(rule).reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0,
  );
  const emojiList = [
    "🌟",
    "🎯",
    "🎨",
    "🎭",
    "🎪",
    "🎢",
    "🎡",
    "🎮",
    "🎲",
    "🎰",
    "🎳",
    "🎹",
    "🎼",
    "🎧",
    "🎤",
    "🎬",
    "🎨",
    "🎭",
    "🎪",
  ];

  return {
    emoji: emojiList[hash % emojiList.length],
    color: cardColors[hash % cardColors.length],
  };
}

@customElement("charm-debugger")
export class CharmDebugger extends LitElement {
  private _entity: Reference | null = null;
  private _behavior: Behavior | null = null;
  private activePopover: RuleDetailsPopover | null = null;
  private activeRuleId: string | null = null;
  private entityProjections: Map<string, Record<string, any>> = new Map();
  private isProjectionsOpen: boolean = false;

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

  private mutationLog: any[] = [];
  private isOpen: boolean = false;
  private isMutationLogOpen: boolean = false;
  private pulsingRules: Set<string> = new Set();

  private projectMutation(mutation: any) {
    const entityId = mutation.entity;
    const changes = mutation.changes;
    let currentState = this.entityProjections.get(entityId) || {};

    for (const change of changes) {
      if (change.Assert || change.Upsert) {
        const [, field, value] = change.Assert || change.Upsert;
        currentState = { ...currentState, [field]: value };
      } else if (change.Retract) {
        const [, field] = change.Retract;
        const { [field]: _, ...rest } = currentState;
        currentState = rest;
      }
    }

    this.entityProjections.set(entityId, currentState);
  }

  private showRuleDetails(rule: string, color: string, activation: any) {
    if (this.activeRuleId === rule) {
      this.activePopover?.remove();
      this.activePopover = null;
      this.activeRuleId = null;
      return;
    }

    this.activePopover?.remove();

    const popover = document.createElement(
      "rule-details-popover",
    ) as RuleDetailsPopover;
    popover.rule = rule;
    popover.color = color;
    popover.activation = activation;
    popover.behavior = this.behavior!;
    this.activePopover = popover;
    this.activeRuleId = rule;
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

    :host(.projections-closed) .content > .projections {
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
      transform-origin: top right;
      transition:
        transform 0.2s ease-in-out,
        opacity 0.2s ease-in-out;
    }

    .rules-grid:hover {
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
      font-family: system-ui;
      border-radius: 128px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      cursor: pointer;
      border: 2px solid white;
      transition: transform 0.2s ease;
      transform: scale(1.2);
      opacity: 0.9;
      position: relative;
    }

    .emoji-tile:hover {
      transform: scale(1.3) rotate(5deg);
      opacity: 1;
    }

    .emoji-tile:hover::before {
      content: attr(data-rule);
      position: absolute;
      right: 100%;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 8px;
      white-space: nowrap;
    }

    .emoji-tile.disabled {
      transform: scale(0.8);
      opacity: 0.5;
      filter: grayscale(1);
    }

    .emoji-tile.disabled:hover {
      transform: scale(0.9);
      opacity: 0.6;
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

    .mutation-log,
    .projections {
      background: #eee;
      border-radius: 8px;
      margin-top: 16px;
      padding: 4px 0px;
      margin-left: -192px;
      max-height: 256px;
      overflow-y: auto;
      border: 1px solid #aaa;
      width: 256px;
    }

    mutation-log-entry {
      padding: 0px 8px;
    }

    .mutation-log mutation-log-entry:nth-child(even) {
      background: rgba(255, 255, 255, 0.5);
    }

    @keyframes pulse {
      0% { transform: scale(1.2); }
      50% { transform: scale(1.5); opacity: 1; }
      100% { transform: scale(1.2); }
    }

    .pulse {
      animation: pulse 0.6s ease-in-out;
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
        this.projectMutation(event.detail);
        this.requestUpdate();
      }
    });

    window.addEventListener("spell-rule-enabled", (event: any) => {
      if (event.detail.id === this.behavior?.id) {
        this.requestUpdate();
      }
    });

    window.addEventListener("spell-rule-disabled", (event: any) => {
      if (event.detail.id === this.behavior?.id) {
        this.requestUpdate();
      }
    });

    if (!this.isOpen) {
      this.classList.add("closed");
    }
    if (!this.isMutationLogOpen) {
      this.classList.add("mutation-log-closed");
    }
    if (!this.isProjectionsOpen) {
      this.classList.add("projections-closed");
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

  toggleProjections() {
    this.isProjectionsOpen = !this.isProjectionsOpen;
    this.classList.toggle("projections-closed");
  }

  override render() {
    return html`
      <div class="content">
        ${this.entity ? html`
          <div>
            <div
              class="entity-id"
              style="background: ${getColorForEntity(this.entity.toString())};"
              title=${this.entity.toString()}
              @click=${this.toggleOpen}
            >
              ${truncateId(this.entity)}
            </div>
            <button
              class="copy-button"
              title="Copy ID"
              @click=${(e: Event) => {
                e.stopPropagation();
                navigator.clipboard.writeText(this.entity!.toString());
              }}
            >📋</button>
            <button
              class="copy-button"
              title="Toggle Log"
              @click=${this.toggleMutationLog}
            >📜</button>
            <button
              class="copy-button"
              title="Toggle Projections"
              @click=${this.toggleProjections}
            >📊</button>
          </div>
        ` : ''}

        ${this.behavior?.rules ? html`<div class="rules-grid">
          ${Object.keys(this.behavior.rules)
            .sort((a, b) => {
              const hasSlashA = a.includes('/');
              const hasSlashB = b.includes('/');
              if (hasSlashA && !hasSlashB) return -1;
              if (!hasSlashA && hasSlashB) return 1;
              return a.localeCompare(b);
            })
            .map((rule, index) => {
              const activation = this.ruleActivations.get(rule);
              const style = getRuleStyle(rule);
              const isEnabled = this.behavior?.isRuleEnabled ? this.behavior.isRuleEnabled(rule) : true;

              return html`
                <div class="rule-item" style="top: ${Math.floor(index / 2) * 96}px">
                  <div
                    class="emoji-tile ${this.pulsingRules.has(rule) ? 'pulse' : ''} ${isEnabled ? '' : 'disabled'}"
                    style="background: ${style.color}"
                    data-rule="${rule}"
                    @click=${() => this.showRuleDetails(rule, style.color, activation)}
                  >
                    ${style.emoji}
                  </div>
                </div>
              `;
            })}
        </div>` : ''}

        <div class="mutation-log">
          ${this.mutationLog.map(
            mutation => html`
              <mutation-log-entry .mutation=${mutation}></mutation-log-entry>
            `,
          )}
        </div>

        <div class="projections">
          ${Array.from(this.entityProjections.entries()).map(
            ([entityId, state]) => html`
              <entity-state-card
                .entityId=${entityId}
                .state=${state}
              ></entity-state-card>
            `,
          )}
        </div>
      </div>
    `;
  }
}
