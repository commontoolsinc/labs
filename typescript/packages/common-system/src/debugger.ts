import { Reference } from "./db.js";
import { Behavior } from "./adapter.js";

function setDebugCharms(value: boolean) {
  (globalThis as any).DEBUG_CHARMS = value;
}

export function getDebugCharms(): boolean {
  return (globalThis as any).DEBUG_CHARMS;
}

setDebugCharms(true);

// const genImage = (prompt: string) =>
//   `/api/img/?prompt=${encodeURIComponent(prompt)}`;

export function truncateId(id: string | Reference) {
  if (typeof id === "object") id = id.toString();

  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export class CharmDebugger extends HTMLElement {
  #root: ShadowRoot;
  #ruleActivations: Map<
    string,
    { count: number; lastSelection: any; performanceMs: number }
  > = new Map();
  #entity: Reference | null = null;
  #behavior: Behavior | null = null;
  #content: HTMLElement;
  #cardColors = [
    "#ff7675",
    "#74b9ff",
    "#55efc4",
    "#ffeaa7",
    "#b2bec3",
    "#fd79a8",
    "#81ecec",
  ];
  #ruleElements: Map<
    string,
    { details: HTMLElement; summary: HTMLElement; pre?: HTMLElement }
  > = new Map();
  #mutationLog: any[] = [];
  #isOpen: boolean = false;
  #isMutationLogOpen: boolean = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
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

    this.#root.appendChild(style);

    this.#content = document.createElement("div");
    this.#content.className = "content";
    this.#root.appendChild(this.#content);

    window.addEventListener("query-triggered", (event: any) => {
      console.log(event);
      if (
        event.detail.entity === this.#entity?.toString() &&
        event.detail.spell == this.#behavior?.id.toString()
      ) {
        const ruleName = event.detail.rule;
        const current = this.#ruleActivations.get(ruleName) || {
          count: 0,
          lastSelection: null,
        };
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
            ruleElements.pre.innerText = JSON.stringify(
              event.detail.match,
              null,
              2,
            );
          } else {
            const pre = document.createElement("pre");
            pre.innerText = JSON.stringify(event.detail.match, null, 2);
            ruleElements.details.appendChild(pre);
            ruleElements.pre = pre;
          }

          // Animate
          ruleElements.details.classList.remove("pulse");
          ruleElements.details.offsetWidth; // Force reflow
          ruleElements.details.classList.add("pulse");
        }
      }
    });

    window.addEventListener("mutation", (event: any) => {
      if (
        event.detail.entity === this.#entity?.toString() &&
        event.detail.spell === this.#behavior?.id.toString()
      ) {
        this.#mutationLog.push(event.detail);
        this.renderMutationLog();
      }
    });

    // Initialize classes based on initial state
    if (!this.#isOpen) {
      this.classList.add("closed");
    }
    if (!this.#isMutationLogOpen) {
      this.classList.add("mutation-log-closed");
    }
  }

  set entity(value: Reference | null) {
    this.#entity = value;
    this.render();
  }

  set behavior(value: Behavior | null) {
    this.#behavior = value;
    this.render();
  }

  renderMutationLog() {
    const logContainer =
      this.#root.querySelector(".mutation-log") ||
      document.createElement("div");
    logContainer.className = "mutation-log";
    logContainer.innerHTML = "";

    const title = document.createElement("div");
    title.innerText = "Mutation Log";
    title.style.fontWeight = "bold";
    logContainer.appendChild(title);

    for (const mutation of this.#mutationLog) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const truncatedRevision = truncateId(mutation.revision);
      summary.innerText = `${mutation.rule}@${truncatedRevision}`;
      summary.title = `${mutation.rule}@${mutation.revision}`;
      details.appendChild(summary);

      const explanation = document.createElement("div");
      explanation.className = "explanation";
      explanation.innerText = mutation.explanation;
      details.appendChild(explanation);

      const selectionDetails = document.createElement("details");
      const selectionSummary = document.createElement("summary");
      selectionSummary.style.fontWeight = "bold";
      selectionSummary.innerText = "Selection";
      selectionDetails.appendChild(selectionSummary);

      const selectionPre = document.createElement("pre");
      selectionPre.innerText = JSON.stringify(mutation.selection, null, 2);
      selectionDetails.appendChild(selectionPre);
      details.appendChild(selectionDetails);

      const changesDetails = document.createElement("details");
      const changesSummary = document.createElement("summary");
      changesSummary.style.fontWeight = "bold";
      changesSummary.innerText = "Changes";
      changesDetails.appendChild(changesSummary);

      const changesPre = document.createElement("pre");
      changesPre.innerText = JSON.stringify(mutation.changes, null, 2);
      changesDetails.appendChild(changesPre);
      details.appendChild(changesDetails);

      logContainer.appendChild(details);
    }

    if (!this.#root.querySelector(".mutation-log")) {
      this.#content.appendChild(logContainer);
    }
  }

  async render() {
    this.#content.innerHTML = "";
    this.#ruleElements.clear();

    if (this.#entity) {
      const entityContainer = document.createElement("div");
      const entityId = document.createElement("div");
      const truncatedId = truncateId(this.#entity.toString());
      entityId.innerText = truncatedId;
      entityId.title = this.#entity.toString();
      entityId.className = "entity-id";
      entityId.style.background =
        this.#cardColors[Math.floor(Math.random() * this.#cardColors.length)];
      entityId.addEventListener("click", () => {
        this.#isOpen = !this.#isOpen;
        this.classList.toggle("closed");
      });

      const copyButton = document.createElement("button");
      copyButton.innerText = "📋";
      copyButton.title = "Copy ID";
      copyButton.className = "copy-button";
      copyButton.addEventListener("click", e => {
        e.stopPropagation();
        navigator.clipboard.writeText(this.#entity!.toString());
      });

      const logButton = document.createElement("button");
      logButton.innerText = "📜";
      logButton.title = "Toggle Log";
      logButton.className = "copy-button";
      logButton.addEventListener("click", () => {
        this.#isMutationLogOpen = !this.#isMutationLogOpen;
        this.classList.toggle("mutation-log-closed");
      });

      entityContainer.appendChild(entityId);
      entityContainer.appendChild(copyButton);
      entityContainer.appendChild(logButton);
      this.#content.appendChild(entityContainer);
    }

    if (this.#behavior?.rules) {
      const rules = Object.keys(this.#behavior.rules);
      const ul = document.createElement("ul");

      for (const rule of rules) {
        const li = document.createElement("li");
        const ruleDetails = document.createElement("details");
        const ruleSummary = document.createElement("summary");

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

        ruleDetails.className = "rule-card";
        ruleDetails.dataset.rule = rule;
        ruleDetails.style.background =
          this.#cardColors[hash % this.#cardColors.length];

        const activation = this.#ruleActivations.get(rule);
        ruleSummary.innerText = `${rule} ${emojiList[hash % emojiList.length]} (${
          activation?.count || 0
        })`;
        ruleDetails.appendChild(ruleSummary);

        let pre;
        if (activation?.lastSelection) {
          pre = document.createElement("pre");
          pre.innerText = JSON.stringify(activation.lastSelection, null, 2);
          ruleDetails.appendChild(pre);
        }

        const ruleExplanation = document.createElement("div");
        ruleExplanation.className = "explanation";
        ruleExplanation.innerText = "Rule:";
        const rulePre = document.createElement("pre");
        rulePre.innerText = JSON.stringify(this.#behavior.rules[rule], null, 2);
        ruleDetails.appendChild(ruleExplanation);
        ruleDetails.appendChild(rulePre);

        const performance = document.createElement("div");
        performance.className = "performance";
        performance.innerText = `${activation?.performanceMs || 0}ms`;
        ruleDetails.appendChild(performance);

        // Add closed by default
        ruleDetails.open = false;

        this.#ruleElements.set(rule, {
          details: ruleDetails,
          summary: ruleSummary,
          pre,
        });

        li.appendChild(ruleDetails);
        ul.appendChild(li);
      }
      this.#content.appendChild(ul);
    }
    this.renderMutationLog();
  }
}

customElements.define("charm-debugger", CharmDebugger);
