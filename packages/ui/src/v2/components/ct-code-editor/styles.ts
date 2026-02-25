import { css } from "lit";

export const styles = css`
  :host {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 200px;
  }

  .code-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .cm-editor {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 1px solid var(--ct-theme-color-border, #e5e7eb);
    border-radius: var(--ct-theme-border-radius, 0.375rem);
    display: flex;
    flex-direction: column;
  }

  .cm-scroller {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .cm-editor.cm-focused {
    outline: none;
  }

  /* Ensure the editor takes full height */
  .cm-content {
    min-height: 100%;
  }

  /* Match v2 component theming */
  .cm-editor {
    font-size: 0.875rem;
    font-family: var(--ct-theme-mono-font-family, monospace);
  }

  /* Focus state with v2 styling */
  .cm-editor.cm-focused {
    box-shadow: 0 0 0 3px var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
  }

  /* Match v2 border radius */
  .cm-editor {
    border-radius: var(--ct-theme-border-radius, 0.375rem);
  }

  /* Prose mode - remove border and focus ring on outer wrapper */
  :host([mode="prose"]) .cm-editor {
    border: none;
    font-family: var(
      --ct-theme-font-family,
      var(
        --ct-font-family-sans,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        sans-serif
      )
    );
    font-size: 1rem;
  }

  :host([mode="prose"]) .cm-editor.cm-focused {
    box-shadow: none;
  }

  /* Prose markdown heading styles */
  .cm-prose-h1 {
    font-size: 1.75em;
    font-weight: 700;
    line-height: 1.3;
  }

  .cm-prose-h2 {
    font-size: 1.4em;
    font-weight: 600;
    line-height: 1.3;
  }

  .cm-prose-h3 {
    font-size: 1.15em;
    font-weight: 600;
    line-height: 1.4;
  }

  .cm-prose-h4 {
    font-size: 1em;
    font-weight: 600;
    line-height: 1.4;
  }

  .cm-prose-h5 {
    font-size: 0.925em;
    font-weight: 600;
    line-height: 1.4;
  }

  .cm-prose-h6 {
    font-size: 0.85em;
    font-weight: 600;
    line-height: 1.4;
  }

  /* Prose inline syntax styles */
  .cm-prose-bold {
    font-weight: 700;
  }

  .cm-prose-italic {
    font-style: italic;
  }

  .cm-prose-bullet {
    color: var(--ct-color-neutral-400, hsl(0, 0%, 60%));
    padding-right: 0.4em;
  }

  .cm-prose-checkbox {
    margin: 0 0.4em 0 0;
    cursor: pointer;
    vertical-align: middle;
  }

  .cm-prose-task-checked {
    text-decoration: line-through;
    color: var(--ct-color-neutral-400, hsl(0, 0%, 60%));
  }

  .cm-prose-footnote {
    color: var(--ct-color-primary-600, hsl(212, 72%, 48%));
    font-size: 0.75em;
    padding-left: 1px;
  }

  .cm-prose-link {
    color: var(--ct-color-primary-600, hsl(212, 72%, 48%));
    text-decoration: underline;
    text-decoration-color: var(
      --ct-color-primary-300,
      hsla(212, 72%, 48%, 0.4)
    );
    text-underline-offset: 2px;
  }

  .cm-prose-inline-code {
    font-family: var(--ct-theme-mono-font-family, monospace);
    font-size: 0.9em;
    background-color: var(--ct-color-neutral-100, hsl(0, 0%, 95%));
    border-radius: 3px;
    padding: 0.1em 0.3em;
  }

  .cm-prose-codeblock {
    background-color: var(--ct-color-neutral-100, hsl(0, 0%, 95%));
    font-family: var(--ct-theme-mono-font-family, monospace);
    font-size: 0.9em;
  }

  .cm-prose-blockquote {
    border-left: 3px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
    padding-left: 1em !important;
    color: var(--ct-color-neutral-500, hsl(0, 0%, 45%));
  }

  .cm-prose-hr {
    border: none;
    border-top: 1px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
    margin: 0;
  }

  .cm-prose-list-number {
    color: var(--ct-color-neutral-400, hsl(0, 0%, 60%));
    padding-right: 0.4em;
  }

  .cm-prose-strikethrough {
    text-decoration: line-through;
  }

  /* Table styling — line-based approach */
  .cm-prose-table-row {
    display: grid !important;
    grid-template-columns: repeat(var(--table-cols, 3), 1fr);
    border-left: 1px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
    border-right: 1px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
    border-bottom: 1px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
  }

  .cm-prose-table-header {
    border-top: 1px solid var(--ct-color-neutral-200, hsl(0, 0%, 88%));
    background-color: var(--ct-color-neutral-50, hsl(0, 0%, 97%));
    font-weight: 600;
  }

  .cm-prose-table-cell {
    padding: 0.35em 0.75em;
  }

  .cm-prose-table-separator {
    height: 0 !important;
    overflow: hidden;
    font-size: 0;
    line-height: 0;
    padding: 0 !important;
  }

  /* Backlink styling - focus-aware display */
  .cm-content .cm-line {
    position: relative;
  }

  /* Collapsed pill view - complete backlink with ID (click to navigate) */
  .cm-backlink-pill {
    background-color: var(--ct-color-primary-100, hsla(212, 100%, 47%, 0.15));
    color: var(--ct-color-primary-700, hsl(212, 80%, 40%));
    border-radius: 9999px;
    padding: 0.125rem 0.5rem;
    cursor: pointer;
    font-weight: 500;
    text-decoration: none;
    transition: background-color var(--ct-theme-animation-duration, 150ms)
      var(--ct-transition-timing-ease);
    }

    .cm-backlink-pill:hover {
      background-color: var(--ct-color-primary-200, hsla(212, 100%, 47%, 0.25));
    }

    /* Pending pill - incomplete backlink without ID */
    .cm-backlink-pending {
      background-color: var(--ct-color-warning-100, hsla(45, 100%, 50%, 0.15));
      color: var(--ct-color-warning-700, hsl(45, 80%, 35%));
      border-radius: 9999px;
      padding: 0.125rem 0.5rem;
      cursor: text;
      font-weight: 500;
      text-decoration: none;
      border: 1px dashed var(--ct-color-warning-400, hsl(45, 70%, 50%));
    }

    /* Editing view - full [[Name (id)]] format visible (for incomplete backlinks) */
    .cm-backlink-editing {
      background-color: var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
      border-radius: 0.25rem;
      padding: 0.125rem 0.25rem;
      text-decoration: none;
    }

    /* Editing mode for name-only view (complete backlinks) */
    .cm-backlink-editing-name {
      background-color: var(--ct-color-primary-100, hsla(212, 100%, 47%, 0.15));
      color: var(--ct-color-primary-700, hsl(212, 80%, 40%));
      border-radius: 0;
      padding: 0.125rem 0;
      font-weight: 500;
      text-decoration: none;
    }

    /* Editing mode bracket styling - shows [[ and ]] */
    .cm-backlink-editing-bracket {
      color: var(--ct-color-neutral-400, hsl(0, 0%, 60%));
      font-weight: normal;
      background-color: var(--ct-color-primary-50, hsla(212, 100%, 47%, 0.08));
    }

    /* Adjacent mode - cursor next to pill, show [[Name]] with visible brackets */
    .cm-backlink-adjacent-bracket {
      color: var(--ct-color-neutral-400, hsl(0, 0%, 60%));
      font-weight: normal;
    }

    .cm-backlink-adjacent-name {
      background-color: var(--ct-color-primary-100, hsla(212, 100%, 47%, 0.15));
      color: var(--ct-color-primary-700, hsl(212, 80%, 40%));
      border-radius: 0.25rem;
      padding: 0.125rem 0.25rem;
      font-weight: 500;
      box-shadow: 0 0 0 1px
        var(--ct-color-primary-200, hsla(212, 100%, 47%, 0.2));
      }

      /* Legacy fallback - keep for any old usages */
      .cm-backlink {
        background-color: var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
        border-radius: 0.25rem;
        padding: 0.125rem 0.25rem;
        cursor: pointer;
        transition: background-color var(--ct-theme-animation-duration, 150ms)
          var(--ct-transition-timing-ease);
        }

        .cm-backlink:hover {
          background-color: var(--ring-alpha, hsla(212, 100%, 47%, 0.2));
        }
      `;
