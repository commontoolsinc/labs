import { css } from 'lit'

export const base = css`
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  list-style: none;
}

:root {
  --unit: 4px;
  --gap: calc(var(--unit) * 5);
  --content-width: 800px;
  --family-sans: "Helvetica Neue", "Helvetica", sans-serif;
  --family-serif: "Times New Roman", "Times", serif;
  --color-white: #fff;
  --color-sepia: #F7F2ED;
  --color-sepia-2: #EFE8E1;
  --color-sepia-3: #FDFAF7;
  --color-brown: #946E47;
  --color-green: #DBDC87;
  --color-green-2: #8C8E0B;
  --color-background: var(--color-sepia);
  --color-secondary-background: var(--color-sepia-2);
  --color-card: var(--color-sepia-3);
  --color-text: #222;
  --body-size: 16px;
  --body-line: 24px;
  --body-font: var(--body-size)/var(--body-line) var(--family-sans);
  --icon-box-size: calc(var(--unit) * 4);
  --radius: calc(var(--unit) * 4);
}

.theme {
  background-color: var(--color-background);
  color: var(--color-text);
  font: var(--body-font);
}
`