import { css } from "lit";

export const styles = css`
  :host {
    --cf-button-border-radius: var(
      --cf-theme-border-radius,
      var(--cf-border-radius-md, 0.375rem)
    );
    --cf-button-border-radius-full: var(
      --cf-theme-border-radius-full,
      var(--cf-border-radius-full, 9999px)
    );
    --cf-button-font-family: var(--cf-theme-font-family, inherit);
    --cf-button-animation-duration: var(--cf-theme-animation-duration, 0.2s);
    --cf-button-spacing-tight: var(--cf-theme-spacing-tight, 0.25rem);
    --cf-button-spacing-normal: var(--cf-theme-spacing-normal, 0.5rem);
    --cf-button-spacing-loose: var(--cf-theme-spacing-loose, 1rem);
    --cf-button-spacing-x-lg: 2rem;
    --cf-button-icon-size: 2.5rem;
    --cf-button-icon-padding: 0;
    --cf-button-color-primary: var(
      --cf-theme-color-primary,
      var(--cf-colors-primary-500, #3b82f6)
    );
    --cf-button-color-primary-foreground: var(
      --cf-theme-color-primary-foreground,
      #ffffff
    );
    --cf-button-color-secondary: var(
      --cf-theme-color-secondary,
      var(--cf-colors-gray-100, #f3f4f6)
    );
    --cf-button-color-secondary-foreground: var(
      --cf-theme-color-secondary-foreground,
      var(--cf-colors-gray-900, #111827)
    );
    --cf-button-color-error: var(
      --cf-theme-color-error,
      var(--cf-colors-error, #dc2626)
    );
    --cf-button-color-error-foreground: var(
      --cf-theme-color-error-foreground,
      #ffffff
    );
    --cf-button-color-border: var(
      --cf-theme-color-border,
      var(--cf-colors-gray-300, #d1d5db)
    );
    --cf-button-color-surface: var(
      --cf-theme-color-surface,
      var(--cf-colors-gray-50, #f9fafb)
    );
    --cf-button-color-surface-hover: var(
      --cf-theme-color-surface-hover,
      var(--cf-colors-gray-200, #e5e7eb)
    );
    --cf-button-color-text: var(
      --cf-theme-color-text,
      var(--cf-colors-gray-900, #111827)
    );
    --cf-button-color-text-muted: var(
      --cf-theme-color-text-muted,
      var(--cf-colors-gray-500, #6b7280)
    );

    display: inline-block;
    outline: none;
    box-sizing: border-box;
  }

  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }

  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: var(
      --cf-button-border-radius,
      var(--cf-border-radius-md, 0.375rem)
    );
    font-size: 0.875rem;
    font-weight: 500;
    font-family: var(--cf-button-font-family, inherit);
    line-height: 1.25rem;
    transition: all var(--cf-button-animation-duration, 0.2s) ease;
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
    outline: 2px solid transparent;
    outline-offset: 2px;
    background-color: transparent;
    background-image: none;
    text-transform: none;
    -webkit-appearance: button;
    text-decoration: none;
  }

  .button:focus-visible {
    outline: 2px solid
      var(--cf-button-color-primary, var(--cf-colors-primary-500, #3b82f6));
    outline-offset: 2px;
  }

  .button:disabled {
    pointer-events: none;
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Size variants */
  .button.default {
    height: 2.5rem;
    padding: var(--cf-button-spacing-normal, 0.5rem)
      var(--cf-button-spacing-loose, 1rem);
    }

    .button.sm {
      height: 2.25rem;
      padding: var(--cf-button-spacing-tight, 0.25rem)
        var(--cf-button-spacing-normal, 0.75rem);
      font-size: 0.75rem;
    }

    .button.lg {
      height: 2.75rem;
      padding: var(--cf-button-spacing-normal, 0.5rem)
        var(--cf-button-spacing-x-lg, 2rem);
      font-size: 1rem;
      line-height: 1.5rem;
    }

    .button.icon {
      height: var(--cf-button-icon-size, 2.5rem);
      width: var(--cf-button-icon-size, 2.5rem);
      padding: var(--cf-button-icon-padding, 0);
    }

    .button.md {
      height: 2rem;
      padding: var(--cf-button-spacing-tight, 0.25rem)
        var(--cf-button-spacing-normal, 0.75rem);
      font-size: 0.75rem;
    }

    /* Variant styles */
    .button.primary {
      background-color: var(
        --cf-button-color-primary,
        var(--cf-colors-primary-500, #3b82f6)
      );
      color: var(
        --cf-button-color-primary-foreground,
        #ffffff
      );
      border-color: var(
        --cf-button-color-primary,
        var(--cf-colors-primary-500, #3b82f6)
      );
    }

    .button.primary:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
    }

    .button.primary:active:not(:disabled) {
      transform: translateY(0);
    }

    .button.destructive {
      background-color: var(
        --cf-button-color-error,
        var(--cf-colors-error, #dc2626)
      );
      color: var(
        --cf-button-color-error-foreground,
        #ffffff
      );
      border-color: var(
        --cf-button-color-error,
        var(--cf-colors-error, #dc2626)
      );
    }

    .button.destructive:hover:not(:disabled) {
      opacity: 0.9;
    }

    .button.outline {
      border-color: var(
        --cf-button-color-border,
        var(--cf-colors-gray-300, #d1d5db)
      );
      background-color: transparent;
      color: var(--cf-button-color-text, var(--cf-colors-gray-900, #111827));
    }

    .button.outline:hover:not(:disabled) {
      background-color: var(
        --cf-button-color-surface,
        var(--cf-colors-gray-50, #f9fafb)
      );
    }

    .button.secondary {
      background-color: var(
        --cf-button-color-secondary,
        var(--cf-colors-gray-100, #f3f4f6)
      );
      color: var(
        --cf-button-color-secondary-foreground,
        var(--cf-colors-gray-900, #111827)
      );
      border-color: var(
        --cf-button-color-secondary,
        var(--cf-colors-gray-100, #f3f4f6)
      );
    }

    .button.secondary:hover:not(:disabled) {
      background-color: var(
        --cf-button-color-surface-hover,
        var(--cf-colors-gray-200, #e5e7eb)
      );
      border-color: var(
        --cf-button-color-surface-hover,
        var(--cf-colors-gray-200, #e5e7eb)
      );
    }

    .button.ghost {
      color: var(
        --cf-button-color-text-muted,
        var(--cf-colors-gray-500, #6b7280)
      );
      background-color: transparent;
      border: none;
      padding: 0;
    }

    .button.ghost:hover:not(:disabled) {
      color: var(--cf-button-color-text, var(--cf-colors-gray-700, #374151));
      background-color: var(
        --cf-button-color-surface-hover,
        var(--cf-colors-gray-100, #f3f4f6)
      );
    }

    .button.ghost.icon {
      width: 1.5rem;
      height: 1.5rem;
      border-radius: var(
        --cf-button-border-radius,
        var(--cf-border-radius-sm, 0.25rem)
      );
    }

    .button.link {
      color: var(
        --cf-button-color-primary,
        var(--cf-colors-primary-500, #3b82f6)
      );
      text-underline-offset: 4px;
    }

    .button.link:hover:not(:disabled) {
      text-decoration: underline;
    }

    .button.pill {
      background: var(
        --cf-button-color-surface,
        var(--cf-colors-gray-100, #f3f4f6)
      );
      color: var(--cf-button-color-text, var(--cf-colors-gray-900, #111827));
      border: 1px solid
        var(--cf-button-color-border, var(--cf-colors-gray-300, #d1d5db));
      border-radius: var(
        --cf-button-border-radius-full,
        var(--cf-radius-full, 9999px)
      );
      height: auto;
      padding: 0.25rem 0.625rem;
      font-size: 0.8125rem;
      line-height: 1;
    }

    .button.pill:hover:not(:disabled) {
      background: var(
        --cf-button-color-surface-hover,
        var(--cf-colors-gray-200, #e5e7eb)
      );
    }
  `;
