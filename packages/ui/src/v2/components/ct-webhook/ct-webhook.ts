import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { CellHandle } from "@commontools/runtime-client";

// Design spec: docs/specs/webhook-ingress/README.md

export interface WebhookConfig {
  url: string;
  secret: string;
}

/**
 * CTWebhook - Webhook integration component
 *
 * Creates and manages a webhook endpoint. The component handles all API
 * interaction internally — patterns never call /api/webhooks directly.
 * Follows the same model as ct-google-oauth: the pattern passes a cell
 * handle, the component manages the lifecycle.
 *
 * The component creates the confidential config cell internally so the
 * pattern never needs to manage CFC labels for secrets.
 *
 * @element ct-webhook
 *
 * @attr {string} name - Human-readable label for the webhook
 * @attr {CellHandle<any>} inbox - Cell that receives webhook payloads (pass via $inbox)
 * @attr {CellHandle<WebhookConfig | null>} config - Cell for URL+secret storage (pass via $config)
 * @attr {"replace" | "append"} mode - Write mode for incoming payloads (default: "replace")
 *
 * @example
 * <ct-webhook
 *   name="GitHub Push Events"
 *   $inbox={webhookInbox}
 *   $config={webhookConfig}
 *   mode="append"
 * />
 */
export class CTWebhook extends BaseElement {
  static override properties = {
    name: { type: String },
    inbox: { type: Object, attribute: false },
    config: { type: Object, attribute: false },
    mode: { type: String },
    _isLoading: { type: Boolean, state: true },
    _error: { type: String, state: true },
  };

  declare name: string;
  declare inbox: CellHandle<unknown>;
  declare config: CellHandle<WebhookConfig | null>;
  declare mode: "replace" | "append";

  declare _isLoading: boolean;
  declare _error: string;

  private _configUnsub?: () => void;

  constructor() {
    super();
    this.name = "";
    this.mode = "replace";
    this._isLoading = false;
    this._error = "";
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("config")) {
      this._subscribeToConfig();
    }
  }

  private _subscribeToConfig() {
    this._configUnsub?.();
    this._configUnsub = undefined;
    if (this.config?.subscribe) {
      this._configUnsub = this.config.subscribe(() => {
        this.requestUpdate();
      });
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._configUnsub?.();
    this._configUnsub = undefined;
  }

  private _getConfig(): WebhookConfig | null {
    try {
      return this.config?.get() ?? null;
    } catch {
      return null;
    }
  }

  private async _handleCreate() {
    if (!this.inbox || !this.config || !this.name) {
      this._error = "Missing required properties: name, inbox, config";
      return;
    }

    if (this.mode !== "replace" && this.mode !== "append") {
      this._error = "Invalid mode: must be 'replace' or 'append'";
      return;
    }

    this._isLoading = true;
    this._error = "";

    try {
      const cellLink = JSON.stringify(this.inbox);
      const confidentialCellLink = JSON.stringify(this.config);

      const response = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: this.name,
          cellLink,
          confidentialCellLink,
          mode: this.mode || "replace",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      await response.json();
      this._isLoading = false;
      this.requestUpdate();
    } catch (error) {
      this._error = error instanceof Error
        ? error.message
        : "Failed to create webhook";
      this._isLoading = false;
    }
  }

  private async _handleDelete() {
    if (this._isLoading) return;

    const configData = this._getConfig();
    if (!configData?.url) return;

    // Extract webhook ID from the config URL format: /api/webhooks/{id}
    const webhookId = new URL(configData.url).pathname.split("/").pop();
    if (!webhookId) return;

    this._isLoading = true;
    this._error = "";

    try {
      // Extract space DID from inbox cell link for ownership verification
      const inboxLink = this.inbox?.toJSON?.() as any;
      const linkData = inboxLink?.["/"]?.["link@1"] ??
        inboxLink?.["/"]?.["link-v0.1"];
      const space = linkData?.space ?? "";
      const params = new URLSearchParams({ space });

      const response = await fetch(
        `/api/webhooks/${webhookId}?${params}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Clear the config cell
      await this.config.set(null);
      this._isLoading = false;
    } catch (error) {
      this._error = error instanceof Error
        ? error.message
        : "Failed to delete webhook";
      this._isLoading = false;
    }
  }

  override render() {
    const configData = this._getConfig();
    const hasWebhook = configData?.url && configData?.secret;

    if (!hasWebhook) {
      return html`
        <div class="webhook-setup">
          <ct-button
            variant="secondary"
            @click="${this._handleCreate}"
            ?disabled="${this._isLoading}"
          >
            ${this._isLoading ? "Creating..." : `Create Webhook`}
          </ct-button>
          ${this._error
            ? html`
              <div class="error" role="alert">${this._error}</div>
            `
            : ""}
        </div>
      `;
    }

    return html`
      <div class="webhook-card">
        <div class="header">
          <span class="name">${this.name}</span>
          <ct-button
            variant="ghost"
            size="sm"
            @click="${this._handleDelete}"
            ?disabled="${this._isLoading}"
          >
            ${this._isLoading ? "..." : "Delete"}
          </ct-button>
        </div>
        <ct-secret-viewer
          label="Webhook URL"
          .value="${configData.url}"
          trailing-chars="8"
        ></ct-secret-viewer>
        <ct-secret-viewer
          label="Bearer Token"
          .value="${configData.secret}"
          trailing-chars="4"
        ></ct-secret-viewer>
        ${this._error
          ? html`
            <div class="error" role="alert">${this._error}</div>
          `
          : ""}
      </div>
    `;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .webhook-setup {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-2, 0.5rem);
      }

      .webhook-card {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-3, 0.75rem);
        padding: var(--spacing-4, 1rem);
        border: 1px solid var(--color-border, #e5e7eb);
        border-radius: var(--radius-md, 0.375rem);
        background: var(--color-bg-subtle, #f9fafb);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .name {
        font-weight: 600;
        font-size: var(--font-size-sm, 0.875rem);
        color: var(--color-text-primary, #111827);
      }

      .error {
        font-size: var(--font-size-sm, 0.875rem);
        color: var(--color-error, #dc2626);
        padding: var(--spacing-2, 0.5rem);
        background: var(--color-error-bg, #fef2f2);
        border-radius: var(--radius-sm, 0.25rem);
      }
    `,
  ];
}

globalThis.customElements.define("ct-webhook", CTWebhook);
