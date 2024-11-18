import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import {
  addRecipe,
  getRecipeSpec,
  getRecipeSrc,
  run,
} from "@commontools/common-runner";
import { addCharms } from "../data.js";
import { buildRecipe } from "../localBuild.js";
import { iterate, llmTweakSpec } from "./spell-ai.js";
import { createRef, ref } from "lit/directives/ref.js";

// NOTE(ja): copied from sidebar.ts ... we need a toasty?
const toasty = (message: string) => {
  const toastEl = document.createElement("div");
  toastEl.textContent = message;
  toastEl.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    z-index: 1000;
  `;
  document.body.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 3000);
};

@customElement("common-spell-editor")
export class CommonSpellEditor extends LitElement {
  @property({ type: String })
  get recipeId() {
    return this.getAttribute("recipeId") ?? "";
  }
  set recipeId(value: string) {
    this.setAttribute("recipeId", value);

    if (value) {
      this.workingSrc = getRecipeSrc(value) ?? "";
      this.recipeSrc = this.workingSrc;
      this.workingSpec = getRecipeSpec(value) ?? "";
      this.recipeSpec = this.workingSpec;
    } else {
      this.workingSrc = "";
      this.recipeSrc = "";
      this.workingSpec = "";
      this.recipeSpec = "";
    }
  }

  @property({ type: String })
  get workingSrc() {
    return this.getAttribute("workingSrc") ?? "";
  }
  set workingSrc(value: string) {
    if (value === this.workingSrc) return;
    console.log("setting src", value.slice(0, 100));
    this.setAttribute("workingSrc", value);
    this.compileErrors = "";
    buildRecipe(value).then(({ errors }) => {
      this.compileErrors = errors || "";
    });

    this.requestUpdate();
  }

  @property({ type: Boolean })
  llmRunning = false;

  @property({ type: String })
  workingSpec = "";

  @property({ type: String })
  recipeSrc = "";

  @property({ type: String })
  recipeSpec = "";

  @property({ type: String })
  compileErrors = "";

  @property({ type: Object })
  data: any = null;

  private editorRef = createRef<HTMLElement>();

  override render() {
    const onSpecChanged = (
      e: CustomEvent,
    ) => (this.workingSpec = e.detail.state.doc.toString());
    const onSrcChanged = (
      e: CustomEvent,
    ) => (this.workingSrc = e.detail.state.doc.toString());

    const revert = () => {
      this.workingSrc = this.recipeSrc;
      this.workingSpec = this.recipeSpec;
      this.requestUpdate();
    };

    const exportData = () => {
      if (!this.data) return;
      const blob = new Blob([JSON.stringify(this.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "arguments.json";
      a.click();
    };

    const askLLM = async ({ fixit }: { fixit?: string } = {}) => {
      this.llmRunning = true;

      try {
        const newSrc = await iterate({
          errors: fixit,
          originalSpec: this.recipeSpec ||
            "there is no spec, describe the app in a descriptive and delcarative way",
          originalSrc: this.recipeSrc,
          workingSpec: this.workingSpec,
          workingSrc: this.workingSrc,
        });
        if (newSrc) {
          this.workingSrc = newSrc;
          this.requestUpdate();
        }
      } finally {
        this.llmRunning = false;
      }
    };

    const tweakSpec = async () => {
      const change = window.prompt("how should we change the spec?");
      if (change) {
        this.llmRunning = true;
        try {
          const newSpec = await llmTweakSpec({
            spec: this.workingSpec,
            change,
          });
          if (newSpec) {
            this.workingSpec = newSpec;
            this.requestUpdate();
          }
        } finally {
          this.llmRunning = false;
        }
      }
    };

    const compileAndUpdate = () => {
      console.log("compileAndUpdate", this.data);
      compileAndRun(this.data);
    };

    const compileAndRunNew = () => {
      compileAndRun();
    };

    const compileAndRun = (data?: any) => {
      buildRecipe(this.workingSrc).then(({ recipe, errors }) => {
        this.compileErrors = errors || "";

        if (!recipe) return;
        // NOTE(ja): adding a recipe triggers saving to blobby
        const parents = this.recipeId ? [this.recipeId] : undefined;
        addRecipe(recipe, this.workingSrc, this.workingSpec, parents);

        // TODO(ja): we should check if the recipe arguments have changed
        // TODO(ja): if default values have changed and source still has to old
        //           defaults, update to new defaults
        const charm = run(recipe, data ?? {});

        addCharms([charm]);
        const charmId = JSON.stringify(charm.entityId);
        this.dispatchEvent(
          new CustomEvent("open-charm", {
            detail: { charmId },
            bubbles: true,
            composed: true,
          }),
        );
        if (data) {
          toasty("Welcome to a new version of this charm!");
        } else {
          toasty("Welcome to a new charm!");
        }
      });
    };

    return html`
      <div>
        <button @click=${compileAndUpdate}>🔄 Run w/Current Data</button>
        <button @click=${compileAndRunNew}>🐣 Run w/New Data</button>
        <button @click=${() =>
      askLLM()} ?disabled=${this.llmRunning}>🤖 LLM</button>
        <button @click=${() =>
      askLLM({ fixit: this.compileErrors })} ?disabled=${
      this.llmRunning || !this.compileErrors
    }>
          🪓 fix it
        </button>
        <button
          @click=${revert}
          ?disabled=${
      this.recipeSrc === this.workingSrc && this.recipeSpec === this.workingSpec
    }
        >
          ↩️ revert
        </button>
        <button @click=${tweakSpec} ?disabled=${this.llmRunning}>🔧 tweak spec</button>
      </div>
      ${
      when(
        this.compileErrors,
        () =>
          html`<pre
                        style="color: white; background: #800; padding: 4px"
                      >
${this.compileErrors}</pre
                      >`,
        () => html``,
      )
    }

        <os-code-editor
          language="text/markdown"
        .source=${this.workingSpec}
        @doc-change=${onSpecChanged}
      ></os-code-editor>

      <os-code-editor
        language="text/x.typescript"
        .source=${this.workingSrc}
        @doc-change=${onSrcChanged}
        ${ref(this.editorRef)}
      ></os-code-editor>
    `;
  }
}
