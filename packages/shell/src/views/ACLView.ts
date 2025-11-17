import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { Task } from "@lit/task";
import { ACLUser, Capability } from "@commontools/memory/acl";
import { RuntimeInternals } from "../lib/runtime.ts";
import "../components/Button.ts";

export class XACLView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 1rem;
      background-color: #f5f5f5;
      border: var(--border-width, 2px) solid var(--border-color, #000);
      margin-top: 1rem;
    }

    .acl-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .acl-header h4 {
      margin: 0;
      font-family: var(--font-primary);
    }

    .acl-list {
      list-style: none;
      padding: 0;
      margin: 0 0 1rem 0;
    }

    .acl-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background-color: white;
      border: 1px solid #ddd;
      margin-bottom: 0.5rem;
    }

    .acl-item-user {
      flex: 1;
      font-family: monospace;
      font-size: 0.9rem;
      word-break: break-all;
      margin-right: 1rem;
    }

    .acl-item-capability {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .capability-select {
      padding: 0.25rem 0.5rem;
      font-family: var(--font-primary);
      border: 1px solid #ccc;
    }

    .add-form {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 1rem;
      background-color: white;
      border: 1px solid #ddd;
      margin-top: 1rem;
    }

    .form-row {
      display: flex;
      gap: 0.5rem;
    }

    .form-row input,
    .form-row select {
      padding: 0.5rem;
      font-family: var(--font-primary);
      border: 1px solid #ccc;
      flex: 1;
    }

    .form-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    .error-message {
      color: #d00;
      padding: 0.5rem;
      background-color: #fee;
      border: 1px solid #d00;
      margin-bottom: 1rem;
    }

    .loading {
      text-align: center;
      padding: 1rem;
    }

    .toggle-button {
      width: auto;
    }
  `;

  @property({ attribute: false })
  rt?: RuntimeInternals;

  @state()
  private expanded = false;

  @state()
  private showAddForm = false;

  @state()
  private newUser = "";

  @state()
  private newCapability: Capability = "READ";

  @state()
  private error?: string;

  private _aclTask = new Task(this, {
    task: async ([rt]) => {
      if (!rt) return undefined;
      try {
        const aclManager = rt.cc().acl();
        return await aclManager.get();
      } catch (err) {
        console.error("Failed to load ACL:", err);
        this.error = err instanceof Error ? err.message : String(err);
        return undefined;
      }
    },
    args: () => [this.rt],
  });

  private async handleCapabilityChange(user: ACLUser, capability: Capability) {
    if (!this.rt) return;

    try {
      this.error = undefined;
      const aclManager = this.rt.cc().acl();
      await aclManager.set(user, capability);
      this._aclTask.run();
    } catch (err) {
      console.error("Failed to update capability:", err);
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async handleRemoveUser(user: ACLUser) {
    if (!this.rt) return;

    try {
      this.error = undefined;
      const aclManager = this.rt.cc().acl();
      await aclManager.remove(user);
      this._aclTask.run();
    } catch (err) {
      console.error("Failed to remove user:", err);
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async handleAddUser(e: Event) {
    e.preventDefault();
    if (!this.rt || !this.newUser.trim()) return;

    try {
      this.error = undefined;
      const aclManager = this.rt.cc().acl();
      await aclManager.set(this.newUser as ACLUser, this.newCapability);
      this.newUser = "";
      this.newCapability = "READ";
      this.showAddForm = false;
      this._aclTask.run();
    } catch (err) {
      console.error("Failed to add user:", err);
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private handleToggle() {
    this.expanded = !this.expanded;
    if (!this.expanded) {
      this.showAddForm = false;
      this.error = undefined;
    }
  }

  private renderACLEntry(user: ACLUser, capability: Capability) {
    return html`
      <li class="acl-item">
        <div class="acl-item-user">${user}</div>
        <div class="acl-item-capability">
          <select
            class="capability-select"
            .value="${capability}"
            @change="${(e: Event) =>
              this.handleCapabilityChange(
                user,
                (e.target as HTMLSelectElement).value as Capability,
              )}"
          >
            <option value="READ">READ</option>
            <option value="WRITE">WRITE</option>
            <option value="OWNER">OWNER</option>
          </select>
          <x-button
            size="small"
            @click="${() => this.handleRemoveUser(user)}"
            title="Remove ${user}"
          >
            Remove
          </x-button>
        </div>
      </li>
    `;
  }

  private renderAddForm() {
    if (!this.showAddForm) {
      return html`
        <x-button
          variant="primary"
          @click="${() => (this.showAddForm = true)}"
        >
          Add User
        </x-button>
      `;
    }

    return html`
      <form class="add-form" @submit="${this.handleAddUser}">
        <div class="form-row">
          <input
            type="text"
            placeholder="DID or * for anyone"
            .value="${this.newUser}"
            @input="${(
              e: Event,
            ) => (this.newUser = (e.target as HTMLInputElement).value)}"
            required
          />
          <select
            .value="${this.newCapability}"
            @change="${(
              e: Event,
            ) => (this.newCapability = (e.target as HTMLSelectElement)
              .value as Capability)}"
          >
            <option value="READ">READ</option>
            <option value="WRITE">WRITE</option>
            <option value="OWNER">OWNER</option>
          </select>
        </div>
        <div class="form-actions">
          <x-button size="small" @click="${() => (this.showAddForm = false)}">
            Cancel
          </x-button>
          <x-button type="submit" size="small" variant="primary">
            Add
          </x-button>
        </div>
      </form>
    `;
  }

  override render() {
    return html`
      <div class="acl-header">
        <h4>Access Control List</h4>
        <x-button
          class="toggle-button"
          size="small"
          @click="${this.handleToggle}"
        >
          ${this.expanded ? "Hide" : "Show"}
        </x-button>
      </div>

      ${this.expanded
        ? html`
          ${this.error
            ? html`
              <div class="error-message">${this.error}</div>
            `
            : null} ${this._aclTask.render({
              pending: () =>
                html`
                  <div class="loading">Loading ACL...</div>
                `,
              complete: (acl) => {
                if (!acl) {
                  return html`
                    <div class="error-message">
                      No ACL initialized for this space.
                    </div>
                  `;
                }

                const entries = Object.entries(acl).filter(
                  ([_, capability]) => capability !== undefined,
                ) as [ACLUser, Capability][];
                return html`
                  <ul class="acl-list">
                    ${entries.map(([user, capability]) =>
                      this.renderACLEntry(user, capability)
                    )}
                  </ul>
                  ${this.renderAddForm()}
                `;
              },
              error: (err) =>
                html`
                  <div class="error-message">
                    Error loading ACL: ${err}
                  </div>
                `,
            })}
        `
        : null}
    `;
  }
}

globalThis.customElements.define("x-acl-view", XACLView);
