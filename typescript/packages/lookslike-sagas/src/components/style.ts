import { css } from 'lit';

export const baseStyles = css`
:host {
  --unit: 8px;
  --secondary-background: #f5f5f5;
  --gap: calc(var(--unit) * 2);
  --body-size: calc(var(--unit) * 4);
  --body-line: calc(var(--unit) * 6);
  --title-size: calc(var(--unit) * 5);
  --title-line: calc(var(--unit) * 6);

  font-family: sans-serif;
}

.body {
  font-size: var(--body-size);
  line-height: var(--body-line);
}
`;