import { LitElement, html, css } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

@customElement("com-thought-log")
export class ComThoughtLog extends LitElement {
  static styles = css`
    .thought-log {
      display: flex;
      flex-direction: column-reverse;
      gap: 1rem;
      max-height: 100vh;
    }

    .thought {
      display: flex;
      flex-direction: column;
    }

    .role {
      font-weight: bold;
      font-family: monospace;
      font-size: 0.8rem;
      line-height: 0.8rem;
    }

    .content {
      font-size: 0.8rem;
      line-height: 0.8rem;
      white-space: pre-wrap;
    }

    .preview {
      font-size: 0.5rem;
      line-height: 0.5rem;
      white-space: nowrap;
      overflow: hidden;
    }
  `;

  @property({ type: Array }) thoughts: {
    [id: number]: ChatCompletionMessageParam;
  } = {};

  render() {
    const thoughts = Object.entries(this.thoughts)
      .toSorted((a, b) => a[0] - b[0])
      .map(([, thought]) => thought);

    return html`<div class="thought-log">
      ${thoughts.map((thought, idx) => {
        const last = idx === thoughts.length - 1;
        const truncatedContent = thought.content?.slice(0, 100) + "...";
        return html`<div class="thought">
          <div class="role">${thought.role}</div>
          ${last
            ? html`<com-markdown
                class="preview"
                markdown=${thought.content}
              ></com-markdown>`
            : html`<com-toggle>
                <com-markdown
                  class="preview"
                  markdown=${thought.content}
                ></com-markdown>
              </com-toggle>`}
        </div>`;
      })}
    </div>`;
  }
}
