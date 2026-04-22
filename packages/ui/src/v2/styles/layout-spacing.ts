import { css } from "lit";

export const layoutSpacingUtilityStyles = css`
  /*
  * Layout utility props map to the shared --cf-spacing-* namespace.
  * Numeric values keep the existing 0/1/2/.../24 contract.
  * T-shirt aliases are shared aliases within the same spacing namespace.
  */

  /* Gap utilities */
  .gap-0 {
    gap: var(--cf-spacing-0, 0);
  }
  .gap-1 {
    gap: var(--cf-spacing-1, 0.25rem);
  }
  .gap-2 {
    gap: var(--cf-spacing-2, 0.5rem);
  }
  .gap-3 {
    gap: var(--cf-spacing-3, 0.75rem);
  }
  .gap-4 {
    gap: var(--cf-spacing-4, 1rem);
  }
  .gap-5 {
    gap: var(--cf-spacing-5, 1.25rem);
  }
  .gap-6 {
    gap: var(--cf-spacing-6, 1.5rem);
  }
  .gap-8 {
    gap: var(--cf-spacing-8, 2rem);
  }
  .gap-10 {
    gap: var(--cf-spacing-10, 2.5rem);
  }
  .gap-12 {
    gap: var(--cf-spacing-12, 3rem);
  }
  .gap-16 {
    gap: var(--cf-spacing-16, 4rem);
  }
  .gap-20 {
    gap: var(--cf-spacing-20, 5rem);
  }
  .gap-24 {
    gap: var(--cf-spacing-24, 6rem);
  }
  .gap-xs {
    gap: var(--cf-spacing-xs, 0.125rem);
  }
  .gap-sm {
    gap: var(--cf-spacing-sm, 0.25rem);
  }
  .gap-md {
    gap: var(--cf-spacing-md, 0.5rem);
  }
  .gap-lg {
    gap: var(--cf-spacing-lg, 0.75rem);
  }
  .gap-xl {
    gap: var(--cf-spacing-xl, 1rem);
  }

  /* Row gap utilities */
  .row-gap-0 {
    row-gap: var(--cf-spacing-0, 0);
  }
  .row-gap-1 {
    row-gap: var(--cf-spacing-1, 0.25rem);
  }
  .row-gap-2 {
    row-gap: var(--cf-spacing-2, 0.5rem);
  }
  .row-gap-3 {
    row-gap: var(--cf-spacing-3, 0.75rem);
  }
  .row-gap-4 {
    row-gap: var(--cf-spacing-4, 1rem);
  }
  .row-gap-5 {
    row-gap: var(--cf-spacing-5, 1.25rem);
  }
  .row-gap-6 {
    row-gap: var(--cf-spacing-6, 1.5rem);
  }
  .row-gap-8 {
    row-gap: var(--cf-spacing-8, 2rem);
  }
  .row-gap-10 {
    row-gap: var(--cf-spacing-10, 2.5rem);
  }
  .row-gap-12 {
    row-gap: var(--cf-spacing-12, 3rem);
  }
  .row-gap-16 {
    row-gap: var(--cf-spacing-16, 4rem);
  }
  .row-gap-20 {
    row-gap: var(--cf-spacing-20, 5rem);
  }
  .row-gap-24 {
    row-gap: var(--cf-spacing-24, 6rem);
  }

  /* Column gap utilities */
  .col-gap-0 {
    column-gap: var(--cf-spacing-0, 0);
  }
  .col-gap-1 {
    column-gap: var(--cf-spacing-1, 0.25rem);
  }
  .col-gap-2 {
    column-gap: var(--cf-spacing-2, 0.5rem);
  }
  .col-gap-3 {
    column-gap: var(--cf-spacing-3, 0.75rem);
  }
  .col-gap-4 {
    column-gap: var(--cf-spacing-4, 1rem);
  }
  .col-gap-5 {
    column-gap: var(--cf-spacing-5, 1.25rem);
  }
  .col-gap-6 {
    column-gap: var(--cf-spacing-6, 1.5rem);
  }
  .col-gap-8 {
    column-gap: var(--cf-spacing-8, 2rem);
  }
  .col-gap-10 {
    column-gap: var(--cf-spacing-10, 2.5rem);
  }
  .col-gap-12 {
    column-gap: var(--cf-spacing-12, 3rem);
  }
  .col-gap-16 {
    column-gap: var(--cf-spacing-16, 4rem);
  }
  .col-gap-20 {
    column-gap: var(--cf-spacing-20, 5rem);
  }
  .col-gap-24 {
    column-gap: var(--cf-spacing-24, 6rem);
  }

  /* Padding utilities */
  .p-0 {
    padding: var(--cf-spacing-0, 0);
  }
  .p-1 {
    padding: var(--cf-spacing-1, 0.25rem);
  }
  .p-2 {
    padding: var(--cf-spacing-2, 0.5rem);
  }
  .p-3 {
    padding: var(--cf-spacing-3, 0.75rem);
  }
  .p-4 {
    padding: var(--cf-spacing-4, 1rem);
  }
  .p-5 {
    padding: var(--cf-spacing-5, 1.25rem);
  }
  .p-6 {
    padding: var(--cf-spacing-6, 1.5rem);
  }
  .p-8 {
    padding: var(--cf-spacing-8, 2rem);
  }
  .p-10 {
    padding: var(--cf-spacing-10, 2.5rem);
  }
  .p-12 {
    padding: var(--cf-spacing-12, 3rem);
  }
  .p-16 {
    padding: var(--cf-spacing-16, 4rem);
  }
  .p-20 {
    padding: var(--cf-spacing-20, 5rem);
  }
  .p-24 {
    padding: var(--cf-spacing-24, 6rem);
  }
  .p-xs {
    padding: var(--cf-spacing-xs, 0.125rem);
  }
  .p-sm {
    padding: var(--cf-spacing-sm, 0.25rem);
  }
  .p-md {
    padding: var(--cf-spacing-md, 0.5rem);
  }
  .p-lg {
    padding: var(--cf-spacing-lg, 0.75rem);
  }
  .p-xl {
    padding: var(--cf-spacing-xl, 1rem);
  }
`;
