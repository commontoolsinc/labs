import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import type { CfcLabelView } from "@commonfabric/runtime-client";

type LabelKey = "classification" | "confidentiality" | "integrity";

type CfcLabelFilter = {
  atom?: string;
  kind?: string;
};

type CfcLabelQueryableValue = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

const LABEL_KEYS = [
  "classification",
  "confidentiality",
  "integrity",
] as const satisfies readonly LabelKey[];

const hasLabelQuery = (value: unknown): value is CfcLabelQueryableValue =>
  typeof value === "object" && value !== null &&
  "getCfcLabel" in value &&
  typeof (value as { getCfcLabel?: unknown }).getCfcLabel === "function";

const stableObjectEntries = (value: Record<string, unknown>) =>
  Object.keys(value).sort().map((key) => [key, value[key]] as const);

const atomObjectField = (value: unknown, field: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
};

const atomMatchesFilter = (
  value: unknown,
  filter: CfcLabelFilter,
): boolean => {
  if (!filter.atom && !filter.kind) {
    return true;
  }

  if (filter.atom) {
    if (typeof value === "string") {
      return value === filter.atom;
    }
    const candidates = [
      atomObjectField(value, "atom"),
      atomObjectField(value, "id"),
      atomObjectField(value, "type"),
      atomObjectField(value, "name"),
    ];
    if (!candidates.includes(filter.atom)) {
      return false;
    }
  }

  if (filter.kind) {
    return atomObjectField(value, "kind") === filter.kind;
  }

  return true;
};

const filteredLabel = (
  label: CfcLabelView["entries"][number]["label"],
  filter: CfcLabelFilter,
): CfcLabelView["entries"][number]["label"] | undefined => {
  const result: CfcLabelView["entries"][number]["label"] = {};
  for (const key of LABEL_KEYS) {
    const values = label[key];
    if (!Array.isArray(values)) {
      continue;
    }
    const filtered = values.filter((value) => atomMatchesFilter(value, filter));
    if (filtered.length > 0) {
      result[key] = filtered;
    }
  }
  return LABEL_KEYS.some((key) => Array.isArray(result[key]))
    ? result
    : undefined;
};

export const filterCfcLabelView = (
  view: CfcLabelView | undefined,
  filter: CfcLabelFilter,
): CfcLabelView | undefined => {
  if (!view) {
    return undefined;
  }
  const entries = view.entries.flatMap((entry) => {
    const label = filteredLabel(entry.label, filter);
    return label ? [{ path: [...entry.path], label }] : [];
  });
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

export const formatCfcLabelAtom = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(
      stableObjectEntries(value as Record<string, unknown>),
    ));
  }
  return JSON.stringify(value);
};

const formatPath = (path: string[]): string =>
  path.length === 0 ? "/" : `/${path.join("/")}`;

/**
 * Renders the CFC label associated with a bound CellHandle value.
 *
 * @element cf-cfc-label
 *
 * @prop {unknown} value - Usually supplied via `$value`; queried for CFC label IPC.
 * @attr {string} atom - Optional exact atom filter.
 * @attr {string} kind - Optional object-atom kind filter.
 */
export class CFCFCLabel extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      color: var(--cf-theme-color-text, hsl(0, 0%, 9%));
      font-size: 0.8125rem;
      line-height: 1.4;
    }

    .label-view {
      display: grid;
      gap: 0.375rem;
    }

    .entry {
      display: grid;
      gap: 0.25rem;
      padding: 0.5rem;
      border: 1px solid var(--cf-theme-color-border, hsl(0, 0%, 86%));
      border-radius: 0.5rem;
      background: var(--cf-theme-color-surface, hsl(0, 0%, 98%));
    }

    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.25rem;
    }

    .kind {
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
      font-weight: 600;
    }

    .atom {
      padding: 0.0625rem 0.375rem;
      border-radius: 999px;
      background: var(--cf-theme-color-muted, hsl(0, 0%, 92%));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
    }

    .empty {
      color: var(--cf-theme-color-text-muted, hsl(0, 0%, 45%));
    }
  `;

  static override properties = {
    value: { attribute: false },
    cfcLabel: { attribute: false },
    atom: { type: String },
    kind: { type: String },
  };

  declare value: unknown;
  declare cfcLabel: CfcLabelView | undefined;
  declare atom: string | undefined;
  declare kind: string | undefined;

  private _labelRequestId = 0;

  constructor() {
    super();
    this.value = undefined;
    this.cfcLabel = undefined;
    this.atom = undefined;
    this.kind = undefined;
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("value")) {
      void this.refreshLabel();
    }
  }

  async refreshLabel(): Promise<void> {
    const requestId = ++this._labelRequestId;
    if (!hasLabelQuery(this.value)) {
      this.cfcLabel = undefined;
      return;
    }

    const cfcLabel = await this.value.getCfcLabel();
    if (requestId === this._labelRequestId) {
      this.cfcLabel = cfcLabel;
    }
  }

  override render() {
    const view = filterCfcLabelView(this.cfcLabel, {
      atom: this.atom,
      kind: this.kind,
    });
    if (!view) {
      return html`
        <span class="empty" part="empty">No CFC label</span>
      `;
    }

    return html`
      <div class="label-view" part="label-view">
        ${view.entries.map((entry) =>
          html`
            <div class="entry" part="entry">
              <div class="path" part="path">${formatPath(entry.path)}</div>
              ${LABEL_KEYS.map((key) => {
                const atoms = entry.label[key];
                return Array.isArray(atoms) && atoms.length > 0
                  ? html`
                    <div class="row" part="row">
                      <span class="kind" part="kind">${key}</span>
                      ${atoms.map((atom) =>
                        html`
                          <span class="atom" part="atom">
                            ${formatCfcLabelAtom(atom)}
                          </span>
                        `
                      )}
                    </div>
                  `
                  : null;
              })}
            </div>
          `
        )}
      </div>
    `;
  }
}

if (!globalThis.customElements.get("cf-cfc-label")) {
  globalThis.customElements.define("cf-cfc-label", CFCFCLabel);
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-cfc-label": CFCFCLabel;
  }
}
