import { html, css, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Reference } from "merkle-reference";
import { makeClient } from "./debug.js";
import { SimpleMessage } from "@commontools/llm-client";
import { Behavior } from "./adapter.js";

type Command = {
  name: string;
  description: string;
  handler: (this: CharmCommand, ...args: any[]) => Promise<void>;
  params?: Array<{
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
  }>;
};

const defaultCommands: Command[] = [
  {
    name: "chat",
    description: "Send message to LLM and get response",
    handler: async function (this: CharmCommand, message: string) {
      // Get behavior context if available
      console.log(this.entity, this.behavior);
      let behaviorContext = "";
      if (this.entity && (this as any).behavior) {
        const behavior = (this as any).behavior as Behavior;
        behaviorContext = `Current charm behavior:\n${JSON.stringify(behavior.rules, null, 2)}`;
      }

      const systemPrompt = `We're building "charms" together in an interactive programming and document management environment. You will receive various commands to modify the document and source code of a charm, but you will also work with the user to implement their dreams.\n\n${behaviorContext}`;

      // Format previous chat history into messages array including both user messages and assistant responses
      const chatHistory: SimpleMessage[] = [];

      // Get all history events sorted by timestamp
      const allHistory = [
        ...this.commandHistory.filter(entry => entry.command === "chat"),
        ...this.eventBuffer,
      ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Format chat history including event context
      for (const entry of allHistory) {
        if (entry.type === "query-triggered") {
          chatHistory.push({
            role: "user" as const,
            content: `Query triggered: ${entry.detail.rule} (${entry.detail.performanceMs}ms)\nPayload: ${JSON.stringify(entry.detail)}`,
          });
        } else if (entry.type === "mutation") {
          chatHistory.push({
            role: "user" as const,
            content: `Mutation: ${entry.detail.rule}\nPayload: ${JSON.stringify(entry.detail)}`,
          });
        } else if (entry.success && entry.response) {
          chatHistory.push({
            role: "assistant" as const,
            content: entry.response as string,
          });
        } else if (entry.params?.message) {
          chatHistory.push({
            role: "user" as const,
            content: entry.params.message as string,
          });
        }
      }

      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, 30000); // 30 second timeout

      try {
        const contextualizedMessage = `User Message: ${message}`;

        const response = await makeClient().sendRequest({
          messages: [
            ...chatHistory,
            { role: "user", content: contextualizedMessage },
          ],
          system: systemPrompt,
          model: "claude-3-5-sonnet",
          // signal: abortController.signal
        });

        clearTimeout(timeout);

        this.commandResponse = response;
        this.commandHistory.push({
          command: "chat",
          timestamp: new Date(),
          success: true,
          role: "assistant",
          response: response,
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
          this.commandResponse = "Command timed out after 30 seconds";
          this.commandHistory.push({
            command: "chat",
            timestamp: new Date(),
            success: false,
            error: "Timeout",
          });
        } else {
          throw err;
        }
      }
    },
    params: [
      {
        name: "message",
        type: "string",
        description: "Message to send",
        required: true,
      },
    ],
  },
  {
    name: "toggle debugger",
    description: "Show/hide debug tools",
    handler: async function () {
      window.dispatchEvent(new CustomEvent("toggle-debugger"));
    },
  },
  {
    name: "modify spell",
    description: "Change charm behavior and regenerate",
    handler: async function () {
      // TODO: Implement spell modification
    },
    params: [
      {
        name: "description",
        type: "string",
        description: "Describe the changes",
        required: true,
      },
    ],
  },
  {
    name: "apply sticker",
    description: "Apply a sticker to the charm",
    handler: async function () {
      // TODO: Implement sticker application
    },
    params: [
      {
        name: "sticker",
        type: "string",
        description: "Sticker name",
        required: true,
      },
    ],
  },
  {
    name: "dispatch event",
    description: "Dispatch a custom event",
    handler: async function () {
      // TODO: Implement event dispatch
    },
    params: [
      {
        name: "eventName",
        type: "string",
        description: "Name of event to dispatch",
        required: true,
      },
      {
        name: "payload",
        type: "string",
        description: "JSON payload (optional)",
        required: false,
      },
    ],
  },
  {
    name: "add tag",
    description: "Add tags to charm",
    handler: async function () {
      // TODO: Implement tag adding
    },
    params: [
      {
        name: "tags",
        type: "string",
        description: "Comma-separated tags",
        required: true,
      },
    ],
  },
  {
    name: "query playground",
    description: "Generate and execute query",
    handler: async function () {
      // TODO: Implement query playground
    },
    params: [
      {
        name: "description",
        type: "string",
        description: "Query description",
        required: true,
      },
    ],
  },
  {
    name: "export",
    description: "Download command history as JSON",
    handler: async function (this: CharmCommand) {
      const history = this.commandHistory;
      const json = JSON.stringify(history, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "command-history.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  },
];

@customElement("charm-command")
export class CharmCommand extends LitElement {
  @property({ attribute: false }) accessor entity: Reference | null = null;
  @property({ attribute: false }) accessor isOpen: boolean = false;
  @property({ type: Array }) accessor commandHistory: any[] = [];
  @property({ type: String }) accessor currentInput: string = "";
  @property({ type: Boolean }) accessor isLoading: boolean = false;
  @property({ type: Object }) accessor activeCommand: Command | null = null;
  @property({ type: Object }) accessor pendingParams: { [key: string]: any } =
    {};
  @property({ type: String }) accessor currentParamPrompt: string = "";
  @property({ type: String }) accessor commandResponse: string = "";
  @property({ type: Boolean }) accessor showHistory: boolean = false;
  @property({ attribute: false }) accessor behavior: Behavior;
  @property({ type: Array }) accessor eventBuffer: any[] = [];

  private commands: Command[] = [...defaultCommands];
  private currentParamIndex: number = 0;

  static override styles = css`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: var(--display, none);
      background: rgba(0, 0, 0, 0);
      justify-content: center;
      align-items: flex-start;
      padding-top: 10vh;
      pointer-events: auto;
      z-index: 1000;
      backdrop-filter: blur(0px);
      transition:
        background 0.2s ease-in-out,
        backdrop-filter 0.2s ease-in-out;
    }

    :host([open]) {
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
    }

    .palette {
      position: relative;
      width: 600px;
      max-height: 400px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      overflow: hidden;
      pointer-events: auto;
      opacity: 0;
      transform: scale(0.98) translateY(-10px);
      transition:
        opacity 0.2s ease-out,
        transform 0.2s ease-out;
    }

    :host([open]) .palette {
      opacity: 1;
      transform: scale(1) translateY(0);
    }

    .input {
      padding: 16px;
      border-bottom: 1px solid #eee;
    }

    input {
      width: 100%;
      padding: 8px;
      font-size: 16px;
      border: none;
      outline: none;
      background: transparent;
    }

    .commands {
      max-height: 300px;
      overflow-y: auto;
    }

    .command {
      padding: 8px 16px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .command:hover {
      background: #f5f5f5;
    }

    .command.selected {
      background: #e0e0e0;
    }

    .history {
      padding: 8px 16px;
      border-top: 1px solid #eee;
      font-size: 14px;
      color: #666;
    }

    .loading {
      text-align: center;
      padding: 16px;
      color: #666;
    }

    .param-prompt {
      padding: 8px 16px;
      color: #666;
      font-size: 14px;
    }

    .response {
      position: absolute;
      bottom: 128px;
      left: 50%;
      transform: translateX(-50%) scale(0.98);
      width: 600px;
      max-height: 256px;
      padding: 16px;
      background: white;
      border-radius: 12px;
      margin-bottom: 16px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      z-index: 1001;
      opacity: 0;
      overflow-y: auto;
      transition:
        opacity 0.2s ease-out,
        transform 0.2s ease-out;
    }

    :host([open]) .response {
      opacity: 1;
      transform: translateX(-50%) scale(1);
    }
  `;

  constructor() {
    super();

    // Handle CMD/CTRL + K
    window.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        this.isOpen = true;
        this.requestUpdate();
      }
    });

    // Handle global open command
    window.addEventListener("open-command-palette", (e: any) => {
      if (e.detail?.entityId === this.entity?.toString()) {
        this.isOpen = true;
        this.requestUpdate();
      }
    });

    // Handle background click
    this.addEventListener("click", (e: MouseEvent) => {
      if (e.target === this) {
        this.isOpen = false;
        this.commandResponse = "";
      }
    });

    // Listen for events
    window.addEventListener("query-triggered", (e: any) => {
      if (e.detail.entity === this.entity?.toString()) {
        this.eventBuffer.push({
          type: "query-triggered",
          detail: e.detail,
          timestamp: new Date(),
        });
      }
    });

    window.addEventListener("mutation", (e: any) => {
      if (e.detail.entity === this.entity?.toString()) {
        this.eventBuffer.push({
          type: "mutation",
          detail: e.detail,
          timestamp: new Date(),
        });
      }
    });
  }

  override updated(changedProps: Map<string, any>) {
    if (changedProps.has("isOpen")) {
      if (this.isOpen) {
        this.setAttribute("open", "");
        this.style.setProperty("--display", "flex");
        setTimeout(() => {
          this.renderRoot.querySelector("input")?.focus();
        }, 0);
      } else {
        this.removeAttribute("open");
        // Delay hiding until animation completes
        setTimeout(() => {
          if (!this.isOpen) {
            this.style.setProperty("--display", "none");
          }
        }, 200);
      }
    }
  }

  override firstUpdated() {
    // No longer needed since we handle focus in updated()
  }

  private async handleCommand(command: Command, e?: Event) {
    e?.preventDefault();
    e?.stopPropagation();

    this.activeCommand = command;
    this.currentParamIndex = 0;
    this.commandResponse = "";

    try {
      if (command.params?.length) {
        this.pendingParams = {};
        this.currentParamPrompt = `Enter ${command.params[0].name} (${command.params[0].description})`;
        return;
      }

      this.isLoading = true;
      await command.handler.call(this);

      this.commandHistory.push({
        command: command.name,
        timestamp: new Date(),
        success: true,
        response: this.commandResponse,
      });
    } catch (err) {
      this.commandHistory.push({
        command: command.name,
        timestamp: new Date(),
        success: false,
        error: err,
      });
    }

    this.isLoading = false;
    this.activeCommand = null;
    this.currentInput = "";
  }

  private async handleParamInput(value: string) {
    if (!this.activeCommand?.params) return;

    const currentParam = this.activeCommand.params[this.currentParamIndex];
    this.pendingParams[currentParam.name] = value;
    this.currentParamIndex++;

    if (this.currentParamIndex < this.activeCommand.params.length) {
      const nextParam = this.activeCommand.params[this.currentParamIndex];
      this.currentParamPrompt = `Enter ${nextParam.name} (${nextParam.description})`;
      this.currentInput = "";
    } else {
      this.isLoading = true;
      this.currentParamPrompt = "";
      this.currentInput = "";

      await this.activeCommand.handler.call(
        this,
        ...Object.values(this.pendingParams),
      );

      this.commandHistory.push({
        command: this.activeCommand.name,
        timestamp: new Date(),
        success: true,
        params: this.pendingParams,
        response: this.commandResponse,
        role: this.activeCommand.name === "chat" ? "user" : undefined,
      });

      this.activeCommand = null;
      this.isLoading = false;
    }
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.isOpen = false;
      this.commandResponse = "";
      this.currentInput = "";
    } else if (e.key === "Enter" && this.currentParamPrompt) {
      this.handleParamInput(this.currentInput);
    } else if (e.key === "Enter" && !this.currentParamPrompt) {
      const selectedCommand = this.commands.find(cmd =>
        cmd.name.toLowerCase().includes(this.currentInput.toLowerCase()),
      );
      if (selectedCommand) {
        this.handleCommand(selectedCommand);
      }
    }
  }

  override render() {
    const filteredCommands = this.commands.filter(cmd =>
      cmd.name.toLowerCase().includes(this.currentInput.toLowerCase()),
    );

    return html`
      ${this.commandResponse
        ? html`<div class="response">
            <common-markdown markdown=${this.commandResponse} />
          </div>`
        : ""}
      <div class="palette" @keydown=${this.handleKeydown}>
        ${this.isOpen
          ? html`
              <div class="input">
                ${this.currentParamPrompt
                  ? html`<div class="param-prompt">
                      ${this.currentParamPrompt}
                    </div>`
                  : ""}
                <input
                  type="text"
                  placeholder=${this.currentParamPrompt
                    ? ""
                    : "Type a command..."}
                  .value=${this.currentInput}
                  @input=${(e: any) => (this.currentInput = e.target.value)}
                />
              </div>

              ${this.isLoading
                ? html`
                    <div class="loading">
                      Executing ${this.activeCommand?.name}...
                    </div>
                  `
                : html`
                    <div class="commands">
                      ${filteredCommands.map(
                        cmd => html`
                          <div
                            class="command"
                            @click=${(e: Event) => this.handleCommand(cmd, e)}
                          >
                            <div>${cmd.name}</div>
                            <div>${cmd.description}</div>
                          </div>
                        `,
                      )}
                    </div>
                  `}
              ${this.showHistory && this.commandHistory.length
                ? html`
                    <div class="history">
                      ${this.commandHistory.map(
                        entry => html`
                          <div>
                            ${entry.command} -
                            ${entry.timestamp.toLocaleTimeString()}
                            ${entry.success ? "✓" : "✗"}
                            ${entry.params ? JSON.stringify(entry.params) : ""}
                            ${entry.response ? `- ${entry.response}` : ""}
                          </div>
                        `,
                      )}
                    </div>
                  `
                : ""}
            `
          : ""}
      </div>
    `;
  }
}
