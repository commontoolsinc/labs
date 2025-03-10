import { css } from "lit";

export const baseStyles = css`
  :host {
    --unit: 4px;
    --radius: calc(var(--unit) * 2);
    --color: #000;
    --secondary-background: #f5f5f5;
    --secondary-color: #777;
    --input-background: #fff;
    --input-color: #000;
    --button-background: #000;
    --button-color: #fff;
    --border-color: #ddd;
    --pad-sm: calc(var(--unit) * 2);
    --pad-md: calc(var(--unit) * 4);
    --pad-lg: calc(var(--unit) * 8);
    --pad-xl: calc(var(--unit) * 16);
    --pad-2xl: calc(var(--unit) * 32);
    --gap: var(--pad);
    --gap-sm: calc(var(--unit) * 2);
    --gap-md: calc(var(--unit) * 4);
    --gap-lg: calc(var(--unit) * 8);
    --gap-xl: calc(var(--unit) * 16);
    --gap-2xl: calc(var(--unit) * 32);
    --body-size: calc(var(--unit) * 4);
    --body-line: calc(var(--unit) * 6);
    --title-size: calc(var(--unit) * 5);
    --title-line: calc(var(--unit) * 6);
    --min-touch-size: calc(var(--unit) * 11);

    font-family: sans-serif;
  }

  .body {
    font-size: var(--body-size);
    line-height: var(--body-line);
  }
`;
