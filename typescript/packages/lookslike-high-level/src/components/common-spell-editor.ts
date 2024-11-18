import { css, html, LitElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { when } from "lit/directives/when.js";
import { style } from "@commontools/common-ui";
import {
  addRecipe,
  cell,
  CellImpl,
  getRecipe,
  getRecipeSpec,
  getRecipeSrc,
  isCell,
  run,
} from "@commontools/common-runner";
import {
  addCharms,
  Charm,
  charms,
  NAME,
  recipes,
  runPersistent,
  TYPE,
  UI,
} from "../data.js";
import { buildRecipe } from "../localBuild.js";
import { LLMClient } from "@commontools/llm-client";
import { createRef, ref } from "lit/directives/ref.js";

const llmUrl = typeof window !== "undefined"
  ? window.location.protocol + "//" + window.location.host + "/api/llm"
  : "//api/llm";

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
      const originalSrc = this.recipeSrc;
      const originalSpec = this.recipeSpec ||
        "there is no spec, describe the app in a descriptive and delcarative way";
      const newSpec = this.workingSpec;

      let prefill = `\`\`\`tsx\n`;
      if (this.workingSrc.includes("//HACK")) {
        console.log("HACK in src");
        prefill += this.workingSrc.split("//HACK")[0];
      }

      const messages = [
        originalSpec,
        `\`\`\`tsx\n${originalSrc}\n\`\`\``,
        newSpec,
        prefill,
      ];

      if (fixit) {
        console.log("fixit", fixit);
        const fixitPrompt = `The user asked you to fix the following:
\`\`\`
${fixit}
\`\`\`

Here is the current source code:
\`\`\`tsx
${this.workingSrc}
\`\`\`

RESPOND WITH THE FULL SOURCE CODE - DO NOT INCLUDE ANY OTHER TEXT.
`;
        messages.push(fixitPrompt);
      }

      const llm = new LLMClient(llmUrl);

      const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system: "You are code generator that implements @commontools recipes.",
        messages,
        stop: "\n```",
      };

      const updateEditor = (text: string) => {
        if (this.editorRef.value) {
          const newSrc = text.split("```tsx\n")[1].split("\n```")[0];
          if (newSrc) {
            this.workingSrc = newSrc;
            this.requestUpdate();
          }
        }
      };

      try {
        const response = await llm.sendRequest(
          payload,
          // updateEditor,
        );

        updateEditor(response);
      } finally {
        this.llmRunning = false;
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
        addRecipe(recipe, this.workingSrc, this.workingSpec);

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
      askLLM({ fixit: this.compileErrors })} ?disabled=${this.llmRunning || !this.compileErrors}>
          🪓 fix it
        </button>
        <button
          @click=${revert}
          ?disabled=${this.recipeSrc === this.workingSrc && this.recipeSpec === this.workingSpec}
        >
          ↩️ revert
        </button>
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
