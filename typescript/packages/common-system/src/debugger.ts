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
  #queryResults: any[] = [];
  #entity: Reference | null = null;
  #behavior: Behavior | null = null;
  #content: HTMLElement;

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
        background: blue;
        padding: 8px;
        font-size: 16px;
        font-family: monospace;
        color: white;
        border: 1px solid #4d4dff;
        border-radius: 4px;
        animation: pulse 2s infinite;
      }

      ul {
        list-style: none;
        padding: 0;
      }

      summary {
        font-size: 12px;
      }

      @keyframes pulse {
        0% {
          border-color: rgba(77, 77, 255, 0.4);
          box-shadow: 0 0 0 0 rgba(77, 77, 255, 0.4);
        }
        70% {
          border-color: rgba(77, 77, 255, 0.8);
          box-shadow: 0 0 0 4px rgba(77, 77, 255, 0);
        }
        100% {
          border-color: rgba(77, 77, 255, 0.4);
          box-shadow: 0 0 0 0 rgba(77, 77, 255, 0);
        }
      }
    `;

    this.#root.appendChild(style);

    this.#content = document.createElement('div');
    this.#content.className = 'content';
    this.#root.appendChild(this.#content);

    window.addEventListener('query-triggered', (event: any) => {
      if (event.detail.entity === this.#entity?.toString() && event.detail.spell == this.#behavior?.id.toString()) {
        this.#queryResults.push(event.detail);
        this.render();
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

  render() {
    this.#content.innerHTML = '';

    const details = document.createElement('details');
    const summary = document.createElement('summary');

    if (this.#entity) {
      summary.innerText = this.#entity.toString();
      details.appendChild(summary);
    }

    if (this.#behavior?.rules) {
      const rules = Object.keys(this.#behavior.rules)
      const ul = document.createElement('ul')
      rules.forEach(async rule => {
        const li = document.createElement('li')
        const ruleDetails = document.createElement('details')
        const ruleSummary = document.createElement('summary')
        ruleSummary.innerText = rule
        ruleDetails.appendChild(ruleSummary)
        const explanation = document.createElement('div')
        explanation.innerText = await explainQuery(this.#behavior?.rules[rule])
        ruleDetails.appendChild(explanation)
        li.appendChild(ruleDetails)
        ul.appendChild(li)
      })
      details.appendChild(ul)
    }

    if (this.#queryResults.length > 0) {
      const queriesDetails = document.createElement('details');
      const queriesSummary = document.createElement('summary');
      queriesSummary.innerText = 'Query Results';
      queriesDetails.appendChild(queriesSummary);

      const pre = document.createElement('pre');
      pre.innerText = JSON.stringify(this.#queryResults, null, 2);
      queriesDetails.appendChild(pre);
      details.appendChild(queriesDetails);
    }

    this.#content.appendChild(details);
  }
}

customElements.define('charm-debugger', CharmDebugger);
