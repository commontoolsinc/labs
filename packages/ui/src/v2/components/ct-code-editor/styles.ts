import { css } from "lit";

export const styles = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 200px;
    position: relative;
  }

  .code-editor {
    display: block;
    height: 100%;
    width: 100%;
    position: relative;
  }

  .cm-editor {
    height: 100%;
    width: 100%;
  }

  .cm-scroller {
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
    font-size: var(--ct-font-size-sm, 0.875rem);
    font-family: var(--ct-font-mono, monospace);
  }

  /* Focus state with v2 styling */
  .cm-editor.cm-focused {
    box-shadow: 0 0 0 3px var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
  }

  /* Match v2 border radius */
  .cm-editor {
    border-radius: var(--radius, 0.375rem);
  }

  /* Backlink styling - make [[backlinks]] visually distinct */
  .cm-content .cm-line {
    position: relative;
  }

  /* Style for backlinks - we'll use a highlight mark */
  .cm-backlink {
    background-color: var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
    border-radius: 0.25rem;
    padding: 0.125rem 0.25rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .cm-backlink:hover {
    background-color: var(--ring-alpha, hsla(212, 100%, 47%, 0.2));
  }
`;
