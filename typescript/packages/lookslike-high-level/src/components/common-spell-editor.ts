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
import { tsToExports } from "../localBuild.js";
import { iterate, llmTweakSpec, generateSuggestions } from "./spell-ai.js";
import { createRef, ref } from "lit/directives/ref.js";
import { spinner } from "../../../common-ui/lib/components/shoelace/index.js";

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
  @property({ type: String, attribute: 'recipe-id' })
  recipeId = '';

  @property({ type: String, attribute: 'working-src' })
  workingSrc = '';

  @property({ type: String })
  spell = '';

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

  @property({ type: String })
  entityId = '';

  @property({ type: Array })
  suggestions: string[] = [];

  private editorRef = createRef<HTMLElement>();

  override updated(changedProperties: Map<string, any>) {
    let makeSuggestions = false;
    if (changedProperties.has('recipeId')) {
      // Handle recipe ID changes
      if (this.recipeId) {
        this.workingSrc = getRecipeSrc(this.recipeId) ?? '';
        this.recipeSrc = this.workingSrc;
        this.workingSpec = getRecipeSpec(this.recipeId) ?? '';
        this.recipeSpec = this.workingSpec;
        makeSuggestions = true;
      } else {
        if (!this.spell) {
          this.workingSrc = '';
          this.recipeSrc = '';
          this.workingSpec = '';
          this.recipeSpec = '';
        }
      }
    }

    if (changedProperties.has('spell')) {
      if (this.spell) {
        this.workingSrc = this.spell;
        this.recipeSrc = this.spell;
        this.workingSpec = '';
        this.recipeSpec = '';
        makeSuggestions = true;
      }
    }

    if (changedProperties.has('workingSrc') && this.workingSrc !== changedProperties.get('workingSrc')) {
      console.log("setting src", this.workingSrc.slice(0, 100));
      this.compileErrors = '';
      tsToExports(this.workingSrc).then(({ errors }) => {
        this.compileErrors = errors || '';
      });
    }

    if (makeSuggestions && this.workingSpec && this.workingSrc) {
      generateSuggestions({
        originalSpec: this.workingSpec,
        originalSrc: this.workingSrc,
      }).then(({ suggestions }) => {
        this.suggestions = suggestions;
        this.requestUpdate();
      });
    }
  }

  override render() {
    const onSpecChanged = (e: CustomEvent) =>
      (this.workingSpec = e.detail.state.doc.toString());
    const onSrcChanged = (e: CustomEvent) =>
      (this.workingSrc = e.detail.state.doc.toString());

    const revert = () => {
      this.workingSrc = this.recipeSrc;
      this.workingSpec = this.recipeSpec;
      this.requestUpdate();
    };

    const askLLM = async ({ fixit }: { fixit?: string } = {}) => {
      if (this.llmRunning) {
        return;
      }

      this.llmRunning = true;

      try {
        const newSrc = await iterate({
          errors: fixit,
          originalSpec:
            this.recipeSpec ||
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
          this.llmRunning = false;
          if (newSpec) {
            this.workingSpec = newSpec;
            askLLM();
            this.requestUpdate();
          }
        } catch (e) {
          this.llmRunning = false;
          console.error(e);
        }
      }
    };

    const compileAndUpdate = () => {
      compileAndRun(true);
    };

    const compileAndRunNew = () => {
      compileAndRun(false);
    };

    const compileAndRun = (keepData?: boolean) => {
      tsToExports(this.workingSrc).then(({ exports, errors }) => {
        this.compileErrors = errors || "";

        let { spell, default: recipe } = exports;

        if (recipe) {
          // NOTE(ja): adding a recipe triggers saving to blobby
          const parents = this.recipeId ? [this.recipeId] : undefined;
          addRecipe(recipe, this.workingSrc, this.workingSpec, parents);

          // TODO(ja): we should check if the recipe arguments have changed
          // TODO(ja): if default values have changed and source still has to old
          //           defaults, update to new defaults
          const charm = run(recipe, keepData ? this.data : {});

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
        }

        if (spell) {
          const charm = spell.spawn({ root: Math.random().toString() }, "compiled", this.workingSrc, keepData ? this.entityId : undefined);
          addCharms([charm]);
          this.dispatchEvent(
            new CustomEvent("open-charm", {
              detail: { charmId: JSON.stringify(charm.entityId) },
              bubbles: true,
              composed: true,
            }),
          );
        }
      });
    };

    const applySuggestion = async (s: { behaviour: string; prompt: string }) => {
      if (s.behaviour === "append") {
        this.workingSpec += `\n${s.prompt}`;
      } else {
        const newSpec = await llmTweakSpec({
          spec: this.workingSpec,
          change: s.prompt,
        });
        this.workingSpec = newSpec;
      }
      askLLM();
      this.requestUpdate();
    };

    return html`
      <div style="margin: 10px;">
        <button @click=${compileAndUpdate} ?disabled=${this.compileErrors || this.workingSrc === this.recipeSrc}>🔄 Run w/Current Data</button>
        <button @click=${compileAndRunNew} ?disabled=${this.compileErrors || this.workingSrc === this.recipeSrc}>🐣 Run w/New Data</button>
        <button @click=${() => askLLM()} ?disabled=${this.llmRunning || this.workingSpec === this.recipeSpec}>
          ${this.llmRunning ? html`<sl-spinner></sl-spinner>` : ""} ✨ code it
        </button>
        <button
          @click=${() => askLLM({ fixit: this.compileErrors })}
          ?disabled=${this.llmRunning || !this.compileErrors}
        >
          ${this.llmRunning ? html`<sl-spinner></sl-spinner>` : ""} 🪓 fix it
        </button>
        <button
          @click=${revert}
          ?disabled=${this.recipeSrc === this.workingSrc &&
      this.recipeSpec === this.workingSpec}
        >
          ↩️ revert
        </button>
        <button @click=${tweakSpec} ?disabled=${this.llmRunning}>
          🔧 tweak spec
        </button>
      </div>
      ${when(
        this.compileErrors,
        () =>
          html`<pre style="color: white; background: #800; padding: 4px">
${this.compileErrors}</pre
          >`,
        () => html``,
      )}

      <div style="margin: 10px;">
        <os-code-editor
          style="margin-bottom: 10px;"
          language="text/markdown"
          .source=${this.workingSpec}
          @doc-change=${onSpecChanged}
        ></os-code-editor>

        ${when(
          this.suggestions.length > 0,
          () =>
            html`<div style="margin-bottom: 10px;">
              ${this.suggestions.map(
                (s) =>
                html`<button @click=${() => applySuggestion(s)}>[${s.behaviour}] ${s.prompt}</button>`,
              )}
            </div>`,
        )}

        <os-code-editor
          language="text/x.typescript"
          .source=${this.workingSrc}
          @doc-change=${onSrcChanged}
          ${ref(this.editorRef)}
        ></os-code-editor>
      </div>
    `;
  }
}
