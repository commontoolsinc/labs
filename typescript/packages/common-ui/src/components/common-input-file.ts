import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { baseStyles } from "./style.js";
import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const commonFileInput = view("common-file-input", {
    ...eventProps(),
    files: { type: "array" },
    filesContent: { type: "array" },
    multiple: { type: "boolean" },
    accept: { type: "string" },
    appearance: { type: "string" },
});

interface FileContent {
    file: File;
    content: string | ArrayBuffer | object | null;
}

export type CommonFileInputDetail = {
    id: string;
    files: File[];
    filesContent: FileContent[];
};

export class CommonFileInputEvent extends Event {
    detail: CommonFileInputDetail;

    constructor(detail: CommonFileInputDetail) {
        super("common-file-input", { bubbles: true, composed: true });
        this.detail = detail;
    }
}

@customElement("common-file-input")
export class CommonFileInputElement extends LitElement {
    static override styles = [
        baseStyles,
        css`
      :host {
        display: block;
      }

      .file-input-wrapper {
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      .file-input {
        appearance: none;
        border: 0;
        outline: 0;
        box-sizing: border-box;
        font-size: var(--body-size);
        width: 100%;
        padding: 8px;
      }

      :host([appearance="rounded"]) .file-input {
        background-color: var(--input-background);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px 16px;
      }
    `,
    ];

    @property({ type: Array }) files: File[] = [];
    @property({ type: Array }) filesContent: FileContent[] = [];
    @property({ type: Boolean }) multiple = false;
    @property({ type: String }) accept: string = "";
    @property({ type: String }) appearance = "default";
    @property({ type: String }) loadMode: 'base64' | 'json' | 'text' = 'base64';

    /**
     * Handles the file input change event.
     * Reads the content of selected files and dispatches an event with file details and contents.
     */
    private async handleChange(event: Event) {
        console.log("handleChange - internal", event);
        const input = event.target as HTMLInputElement;
        if (input.files) {
            this.files = Array.from(input.files);
            this.filesContent = await this.readFiles(this.files);

            this.dispatchEvent(
                new CommonFileInputEvent({
                    id: this.id,
                    files: this.files,
                    filesContent: this.filesContent,
                })
            );
        }
    }

    /**
     * Reads the content of each selected file.
     * @param files Array of File objects to be read.
     * @returns Promise resolving to an array containing each file and its content.
     */
    private async readFiles(
        files: File[]
    ): Promise<FileContent[]> {
        const readFile = (file: File): Promise<FileContent> => {
            return new Promise((resolve) => {
                const reader = new FileReader();

                reader.onload = () => {
                    let content: string | ArrayBuffer | object | null = reader.result;
                    if (this.loadMode === 'json' && typeof reader.result === 'string') {
                        try {
                            content = JSON.parse(reader.result);
                        } catch (error) {
                            console.error(`Error parsing JSON from file: ${file.name}`, error);
                            content = null;
                        }
                    }
                    resolve({ file, content });
                };

                reader.onerror = () => {
                    console.error(`Error reading file: ${file.name}`);
                    resolve({ file, content: null });
                };

                switch (this.loadMode) {
                    case 'base64':
                        reader.readAsDataURL(file);
                        break;
                    case 'text':
                    case 'json':
                        reader.readAsText(file);
                        break;
                    default:
                        reader.readAsDataURL(file);
                }
            });
        };

        return Promise.all(files.map(readFile));
    }

    override render() {
        return html`
      <div class="file-input-wrapper">
        <input
          class="file-input"
          type="file"
          @change="${this.handleChange}"
          ?multiple="${this.multiple}"
          accept="${this.accept}"
        />
      </div>
    `;
    }
}