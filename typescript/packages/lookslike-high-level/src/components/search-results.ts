import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

export interface SpellSearchResult {
  key: string;
  name: string;
  description: string;
  matchType: string;
  compatibleBlobs: {
    key: string;
    snippet: string;
    data: {
      count: number;
      blobCreatedAt: string;
      blobAuthor: string;
    };
  }[];
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInMillis = now.getTime() - date.getTime();
  const diffInMinutes = Math.floor(diffInMillis / (1000 * 60));
  const diffInHours = Math.floor(diffInMillis / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMillis / (1000 * 60 * 60 * 24));

  if (diffInMinutes < 1) {
    return "just now";
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes} minute${diffInMinutes === 1 ? "" : "s"} ago`;
  }
  if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours === 1 ? "" : "s"} ago`;
  }
  if (diffInDays < 30) {
    return `${diffInDays} day${diffInDays === 1 ? "" : "s"} ago`;
  }

  return date.toLocaleDateString();
}

@customElement("common-search-results")
export default class SearchResults extends LitElement {
  @property({ type: Boolean })
  searchOpen = false;

  @property({ type: Array })
  results: SpellSearchResult[] = [];

  @state()
  focusedResult: SpellSearchResult | null = null;

  private handleClose() {
    this.searchOpen = false;
    this.dispatchEvent(new CustomEvent("close"));
  }

  private handleSearch(e: CustomEvent) {
    const query = e.detail.query;
    this.dispatchEvent(new CustomEvent("search", { detail: { query } }));
  }

  private handleResultClick(result: SpellSearchResult) {
    this.focusedResult = result;
    this.dispatchEvent(new CustomEvent("select", { detail: { result } }));
    this.searchOpen = false;
  }

  override render() {
    return html`
      <style>
        .results-grid {
          max-height: 50vh;
          overflow-y: auto;
        }

        .result-card {
        }

        .blob-list {
          margin-top: 1rem;
        }

        .blob-item {
          padding: 0.5rem;
          border-radius: 4px;
          cursor: pointer;
        }

        .blob-item:hover {
          background: #f5f5f5;
        }

        .blob-meta {
          font-size: 0.9em;
          color: #666;
          margin-top: 0.25rem;
        }
      </style>

      <os-dialog .open=${this.searchOpen} @closedialog=${this.handleClose}>
        <div class="results-grid">
          ${repeat(
            this.results,
            (result) => result.key,
            (result) => html`
              <div class="result-card">
                <div class="blob-list">
                  ${repeat(
                    result.compatibleBlobs,
                    (blob) => blob.key,
                    (blob) => html`
                      <os-charm-row
                        icon="search"
                        text=${result.description}
                        subtitle=${`${blob.key}, ${formatRelativeTime(blob.data.blobCreatedAt)}`}
                        @click=${() =>
                          this.dispatchEvent(
                            new CustomEvent("spell-cast", {
                              detail: {
                                spell: result,
                                blob: blob,
                              },
                            }),
                          )}
                      ></os-charm-row>
                    `,
                  )}
                </div>
              </div>
            `,
          )}
        </div>
      </os-dialog>
    `;
  }
}
