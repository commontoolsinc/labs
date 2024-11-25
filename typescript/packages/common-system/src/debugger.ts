import { Reference } from "./db.js";
import { explainQuery } from './debug.js'
import { Behavior } from "./adapter.js";

function setDebugCharms(value: boolean) {
  (globalThis as any).DEBUG_CHARMS = value;
}

export function getDebugCharms(): boolean {
  return (globalThis as any).DEBUG_CHARMS;
}

setDebugCharms(true);

export class CharmDebugger extends HTMLElement {
  #root: ShadowRoot;
  #ruleActivations: Map<string, {count: number, lastSelection: any, performanceMs: number }> = new Map();
  #entity: Reference | null = null;
  #behavior: Behavior | null = null;
  #content: HTMLElement;
  #cardColors = ['#ff7675', '#74b9ff', '#55efc4', '#ffeaa7', '#b2bec3', '#fd79a8', '#81ecec'];
  #ruleElements: Map<string, {details: HTMLElement, summary: HTMLElement, pre?: HTMLElement}> = new Map();

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: absolute;
        top: 4px;
        right: 4px;
        min-width: 128px;
        width: 33%;
        max-height: 512px;
        overflow-y: auto;
        font-size: 16px;
        font-family: monospace;
        color: black;
      }

      ul {
        list-style: none;
        padding: 0;
      }

      details {
        margin-bottom: 8px;
        border-radius: 4px;
        padding: 8px;
      }

      summary {
        font-size: 18px;
        font-weight: bold;
        cursor: pointer;
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
        border-radius: 4px;
        margin-bottom: 8px;
        padding: 12px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }

      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.05); }
        100% { transform: scale(1); }
      }

      .pulse {
        animation: pulse 0.3s ease-in-out;
      }
    `;

    this.#root.appendChild(style);

    this.#content = document.createElement('div');
    this.#content.className = 'content';
    this.#root.appendChild(this.#content);

    window.addEventListener('query-triggered', (event: any) => {
      console.log(event)
      if (event.detail.entity === this.#entity?.toString() && event.detail.spell == this.#behavior?.id.toString()) {
        const ruleName = event.detail.rule;
        const current = this.#ruleActivations.get(ruleName) || {count: 0, lastSelection: null};
        this.#ruleActivations.set(ruleName, {
          count: current.count + 1,
          lastSelection: event.detail.match,
          performanceMs: event.detail.performanceMs,
        });

        const ruleElements = this.#ruleElements.get(ruleName);
        if (ruleElements) {
          // Update count
          ruleElements.summary.innerText = `${ruleName} (${current.count + 1})`;

          // Update selection
          if (ruleElements.pre) {
            ruleElements.pre.innerText = JSON.stringify(event.detail.match, null, 2);
          } else {
            const pre = document.createElement('pre');
            pre.innerText = JSON.stringify(event.detail.match, null, 2);
            ruleElements.details.appendChild(pre);
            ruleElements.pre = pre;
          }

          // Animate
          ruleElements.details.classList.remove('pulse');
          ruleElements.details.offsetWidth; // Force reflow
          ruleElements.details.classList.add('pulse');
        }
      }
    });
  }

  set entity(value: Reference | null) {
    this.#entity = value;
    this.render();
  }

  set behavior(value: Behavior | null) {
    this.#behavior = value;
    this.render();
  }

  async render() {
    this.#content.innerHTML = '';
    this.#ruleElements.clear();

    if (this.#entity) {
      const entityId = document.createElement('div');
      entityId.innerText = this.#entity.toString();
      this.#content.appendChild(entityId);
    }

    if (this.#behavior?.rules) {
      const rules = Object.keys(this.#behavior.rules)
      const ul = document.createElement('ul')

      for (const rule of rules) {
        const li = document.createElement('li')
        const ruleDetails = document.createElement('details')
        const ruleSummary = document.createElement('summary')

        ruleDetails.className = 'rule-card';
        ruleDetails.dataset.rule = rule;
        ruleDetails.style.background = this.#cardColors[Math.floor(Math.random() * this.#cardColors.length)];

        const explanation = document.createElement('div')
        explanation.className = 'explanation';

        const activation = this.#ruleActivations.get(rule);
        ruleSummary.innerText = `${rule} (${activation?.count || 0})`;
        ruleDetails.appendChild(ruleSummary)

        let pre;
        if (activation?.lastSelection) {
          pre = document.createElement('pre');
          pre.innerText = JSON.stringify(activation.lastSelection, null, 2);
          ruleDetails.appendChild(pre);
        }

        explanation.innerText = await explainQuery(this.#behavior.rules[rule])
        ruleDetails.appendChild(explanation)

        const performance = document.createElement('div');
        performance.className = 'performance';
        performance.innerText = `${activation?.performanceMs || 0}ms`;
        ruleDetails.appendChild(performance);

        this.#ruleElements.set(rule, {
          details: ruleDetails,
          summary: ruleSummary,
          pre
        });

        li.appendChild(ruleDetails)
        ul.appendChild(li)
      }
      this.#content.appendChild(ul)
    }
  }
}

customElements.define('charm-debugger', CharmDebugger);
