import { css } from 'lit';

export const baseStyles = css`
:host {
  --unit: 4px;
  --radius: calc(var(--unit) * 1);
  --radius-lg: calc(var(--unit) * 4);
  --background: #fff;
  --secondary-background: #f5f5f5;
  --input-background: #fff;
  --input-color: #000;
  --button-background: #000;
  --button-color: #fff;
  --border-color: #ddd;
  --pad: calc(var(--unit) * 2);
  --gap: calc(var(--unit) * 4);
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

export const iconStyles = css`
.material-symbols-outlined {
  font-family: 'Material Symbols Outlined';
  font-weight: normal;
  font-style: normal;
  font-size: 24px;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  display: inline-block;
  white-space: nowrap;
  word-wrap: normal;
  direction: ltr;
  -webkit-font-feature-settings: 'liga';
  -webkit-font-smoothing: antialiased;
}
`;