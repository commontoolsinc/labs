import { css } from 'lit';

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
  --pad: calc(var(--unit) * 4);
  --gap: var(--pad);
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