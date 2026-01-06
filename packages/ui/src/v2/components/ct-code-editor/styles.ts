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
      border-radius: 9999px;
      padding: 0.125rem 0.5rem;
      font-weight: 500;
      text-decoration: none;
      /* Focus ring to indicate editing */
      box-shadow: 0 0 0 2px var(--ct-color-primary-300, hsla(212, 100%, 47%, 0.3));
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
