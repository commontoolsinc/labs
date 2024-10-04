import { css } from "lit";

export const base = css`
  @font-face {
    font-family: "Material Symbols Rounded";
    font-style: normal;
    src: url("./material-symbols.woff") format("woff");
  }

  .material-symbols-rounded {
    font-family: "Material Symbols Rounded";
    font-weight: normal;
    font-style: normal;
    font-size: 24px; /* Preferred icon size */
    display: inline-block;
    line-height: 1;
    text-transform: none;
    letter-spacing: normal;
    word-wrap: normal;
    white-space: nowrap;
    direction: ltr;
    font-variation-settings:
      "FILL" 1,
      "GRAD" 200;
  }

  :host {
    /*
    Baseline grid unit.
    - Components should line up to 8px baseline grid (2x multiples)
    - Text and icons should line up to 4px baseline grid (1x multiples)
    */
    --u: 4px;
    --min-touch-size: calc(var(--u) * 11);
    --toolbar-height: calc(var(--u) * 24);
    --radius: calc(var(--u) * 3);
    --radius-2: calc(var(--u) * 6);
    /* Body size 17px */
    --body-size: calc(var(--u) * 4.25);
    --body-line: calc(var(--u) * 6);
    /* Heading size 24px */
    --heading-size: calc(var(--u) * 6);
    --heading-line: calc(var(--u) * 7);
    /* Large text size 24px with more generous line height */
    --lg-line: calc(var(--u) * 6);
    --lg-line: calc(var(--u) * 8);
    /* sm size 13px */
    --sm-size: calc(var(--u) * 3.25);
    --sm-line: calc(var(--u) * 5);
    /* xsm size 11px */
    --xsm-size: calc(var(--u) * 2.75);
    --xsm-line: calc(var(--u) * 4);
    --pad: calc(var(--u) * 6);
    --gap: calc(var(--u) * 6);
    --gap-sm: calc(var(--u) * 4);
    --gap-xsm: calc(var(--u) * 2);
    --bg: #fff;
    --bg-1: #fafafa;
    --bg-2: #f0f0f0;
    --bg-3: #d2d2d2;
    --bg-scrim: rgb(0 0 0 / 5%);
    --c-border: #d0d0d0;
    --c-text: #000;
    --c-text-2: #969696;
    --c-placeholder: rgb(0, 0, 0 / 20%);
    --shadow-menu: 0px 2px 4px rgb(0, 0, 0, 8%), 0px 0px 10px rgb(0, 0, 0, 8%);
    --font-family: Helvetica, sans-serif;
    --dur-sm: 250ms;
    --dur-md: 350ms;
    --dur-lg: 500ms;
    --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
    --ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);

    display: block;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    font-weight: normal;
    color: var(--c-text);
    font-family: var(--font-family);
    font-size: var(--body-size);
    line-height: var(--body-line);
    list-style: none;
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .defaults {
    display: block;
    color: var(--c-text);
    font-family: var(--font-family);
    font-size: var(--body-size);
    line-height: var(--body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .body {
    font-family: var(--font-family);
    font-size: var(--body-size);
    line-height: var(--body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .lg {
    font-family: var(--font-family);
    font-size: var(--lg-line);
    line-height: var(--lg-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .sm {
    font-family: var(--font-family);
    font-size: var(--sm-size);
    line-height: var(--sm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .xsm {
    font-family: var(--font-family);
    font-size: var(--xsm-size);
    line-height: var(--xsm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .title {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--body-size);
    line-height: var(--body-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .heading {
    font-weight: bold;
    font-family: var(--font-family);
    font-size: var(--heading-size);
    line-height: var(--heading-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .label {
    color: var(--c-text-2);
    font-weight: normal;
    text-transform: uppercase;
    font-family: var(--font-family);
    font-size: var(--xsm-size);
    line-height: var(--xsm-line);
    -webkit-font-smoothing: antialiased;
    font-smooth: antialiased;
  }

  .c-text {
    color: var(--c-text);
  }

  .c-text-2 {
    color: var(--c-text-2);
  }

  .vstack {
    display: flex;
    flex-direction: column;
  }

  .hstack {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .gap {
    gap: var(--gap);
  }

  .gap-sm {
    gap: var(--gap-sm);
  }

  .gap-xsm {
    gap: var(--gap-xsm);
  }

  .pad {
    padding: var(--pad);
  }

  .pad-t {
    padding-top: var(--pad);
  }

  .pad-b {
    padding-bottom: var(--pad);
  }

  .pad-h {
    padding-left: var(--pad);
    padding-right: var(--pad);
  }

  .pad-v {
    padding-top: var(--pad);
    padding-bottom: var(--pad);
  }

  .toolbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: "start center end";
    align-items: center;
    gap: var(--gap-sm);

    .toolbar-start {
      grid-area: start;
      display: flex;
      gap: var(--button-gap);
      align-items: center;
      justify-content: flex-start;
      min-width: 104px;
    }

    .toolbar-end {
      grid-area: end;
      display: flex;
      gap: var(--button-gap);
      align-items: center;
      justify-content: flex-end;
      min-width: 100px;
    }

    .toolbar-center {
      grid-area: center;
      display: flex;
      gap: var(--button-gap);
      align-items: center;
      justify-content: center;
    }
  }

  /*
  Fade out element by toggling ".fade.fade-out".
  Hidden element will have zero opacity and will not be interactable, but will
  still have the same box size in the DOM.
  */
  .fade {
    transition: opacity var(--dur-md) var(--ease-out-expo);

    &.fade-out {
      opacity: 0;
      pointer-events: none;
    }
  }
`;
