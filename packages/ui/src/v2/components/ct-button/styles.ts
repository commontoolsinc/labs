import { css } from "lit";

export const styles = css`
  :host {
    --ct-button-border-radius: var(
      --ct-theme-border-radius,
      var(--ct-border-radius-md, 1.75rem)
    );
    --ct-button-border-radius-full: var(
      --ct-theme-border-radius-full,
      var(--ct-border-radius-full, 9999px)
    );
    --ct-button-font-family: var(--ct-theme-font-family, inherit);
    --ct-button-animation-duration: var(--ct-theme-animation-duration, 0.2s);
    --ct-button-spacing-tight: var(--ct-theme-spacing-tight, 0.25rem);
    --ct-button-spacing-normal: var(--ct-theme-spacing-normal, 0.5rem);
    --ct-button-spacing-loose: var(--ct-theme-spacing-loose, 1rem);
    --ct-button-spacing-x-lg: 2rem;
    --ct-button-icon-size: 2.5rem;
    --ct-button-icon-padding: 0;
    --ct-button-color-primary: var(
      --ct-theme-color-primary,
      var(--ct-colors-primary-500, #2d8c3c)
    );
    --ct-button-color-primary-foreground: var(
      --ct-theme-color-primary-foreground,
      #ffffff
    );
    --ct-button-color-secondary: var(
      --ct-theme-color-secondary,
      var(--ct-colors-gray-100, #f0ede6)
    );
    --ct-button-color-secondary-foreground: var(
      --ct-theme-color-secondary-foreground,
      var(--ct-colors-gray-900, #2c3227)
    );
    --ct-button-color-error: var(
      --ct-theme-color-error,
      var(--ct-colors-error, #c44536)
    );
    --ct-button-color-error-foreground: var(
      --ct-theme-color-error-foreground,
      #ffffff
    );
    --ct-button-color-border: var(
      --ct-theme-color-border,
      var(--ct-colors-gray-300, #d4d2c8)
    );
    --ct-button-color-surface: var(
      --ct-theme-color-surface,
      var(--ct-colors-gray-50, #f3f1eb)
    );
    --ct-button-color-surface-hover: var(
      --ct-theme-color-surface-hover,
      var(--ct-colors-gray-200, #e8e6dd)
    );
    --ct-button-color-text: var(
      --ct-theme-color-text,
      var(--ct-colors-gray-900, #2c3227)
    );
    --ct-button-color-text-muted: var(
      --ct-theme-color-text-muted,
      var(--ct-colors-gray-500, #7a7d72)
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
    gap: 0.375rem;
    white-space: nowrap;
    border-radius: var(
      --ct-button-border-radius,
      1.75rem
    );
    font-size: 1rem;
    font-weight: 700;
    font-family: var(--ct-button-font-family, inherit);
    line-height: 1.5rem;
    transition: all var(--ct-button-animation-duration, 0.2s)
      cubic-bezier(0.25, 0.1, 0.25, 1);
    cursor: pointer;
    user-select: none;
    border: 2px solid transparent;
    outline: none;
    background-color: transparent;
    background-image: none;
    text-transform: none;
    -webkit-appearance: button;
    text-decoration: none;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .button:focus-visible {
    box-shadow:
      0 0 0 2px var(--ct-theme-color-background, #fdfcf9),
      0 0 0 4px var(--ct-button-color-primary, #2d8c3c);
    }

    .button:active:not(:disabled) {
      transform: scale(0.97);
      transition-duration: 0.1s;
    }

    .button:disabled {
      pointer-events: none;
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Size variants */
    .button.default {
      height: 2.75rem;
      padding: 0.625rem 1.5rem;
    }

    .button.sm {
      height: 2.25rem;
      padding: 0.375rem 1rem;
      font-size: 0.875rem;
      font-weight: 700;
    }

    .button.lg {
      height: 3.25rem;
      padding: 0.875rem 2rem;
      font-size: 1rem;
    }

    .button.icon {
      height: var(--ct-button-icon-size, 2.5rem);
      width: var(--ct-button-icon-size, 2.5rem);
      padding: var(--ct-button-icon-padding, 0);
      border-radius: 50%;
    }

    .button.md {
      height: 2.5rem;
      padding: 0.5rem 1.25rem;
      font-size: 0.875rem;
    }

    /* Variant styles */
    .button.primary {
      background-color: var(
        --ct-button-color-primary,
        #2d8c3c
      );
      color: var(
        --ct-button-color-primary-foreground,
        #ffffff
      );
      border-color: transparent;
      box-shadow:
        0 2px 4px rgba(45, 70, 40, 0.15),
        0 1px 2px rgba(45, 70, 40, 0.08);
      }

      .button.primary:hover:not(:disabled) {
        filter: brightness(0.88);
        box-shadow:
          0 4px 12px rgba(45, 70, 40, 0.2),
          0 2px 4px rgba(45, 70, 40, 0.1);
        }

        .button.destructive {
          background-color: var(
            --ct-button-color-error,
            #c44536
          );
          color: var(
            --ct-button-color-error-foreground,
            #ffffff
          );
          border-color: transparent;
          box-shadow:
            0 2px 4px rgba(120, 50, 40, 0.15),
            0 1px 2px rgba(120, 50, 40, 0.08);
          }

          .button.destructive:hover:not(:disabled) {
            filter: brightness(0.88);
            box-shadow:
              0 4px 12px rgba(120, 50, 40, 0.2),
              0 2px 4px rgba(120, 50, 40, 0.1);
            }

            .button.outline {
              border-color: var(
                --ct-button-color-text,
                #2c3227
              );
              background-color: transparent;
              color: var(--ct-button-color-text, #2c3227);
            }

            .button.outline:hover:not(:disabled) {
              background-color: var(
                --ct-button-color-surface,
                #f3f1eb
              );
            }

            .button.secondary {
              background-color: var(
                --ct-button-color-secondary,
                #f0ede6
              );
              color: var(
                --ct-button-color-secondary-foreground,
                #2c3227
              );
              border-color: transparent;
            }

            .button.secondary:hover:not(:disabled) {
              background-color: var(
                --ct-button-color-surface-hover,
                #e8e6dd
              );
            }

            .button.ghost {
              color: var(
                --ct-button-color-text-muted,
                #7a7d72
              );
              background-color: transparent;
              border: none;
              padding-inline: 0.625rem;
            }

            .button.ghost.sm {
              padding-inline: 0.75rem;
            }

            .button.ghost:hover:not(:disabled) {
              color: var(--ct-button-color-text, #2c3227);
              background-color: var(
                --ct-button-color-surface-hover,
                #f3f1eb
              );
            }

            .button.ghost.icon {
              width: 1.5rem;
              height: 1.5rem;
              border-radius: 50%;
            }

            .button.link {
              color: var(
                --ct-button-color-primary,
                #2d8c3c
              );
              text-underline-offset: 4px;
              font-weight: 700;
            }

            .button.link:hover:not(:disabled) {
              filter: brightness(0.85);
              text-decoration: underline;
            }

            .button.pill {
              background: var(
                --ct-button-color-surface,
                #f3f1eb
              );
              color: var(--ct-button-color-text, #2c3227);
              border: 1.5px solid var(--ct-button-color-border, #d4d2c8);
              border-radius: var(
                --ct-button-border-radius-full,
                9999px
              );
              height: auto;
              padding: 0.3125rem 0.875rem;
              font-size: 0.875rem;
              font-weight: 700;
              line-height: 1;
            }

            .button.pill:hover:not(:disabled) {
              background: var(
                --ct-button-color-surface-hover,
                #e8e6dd
              );
            }
          `;
