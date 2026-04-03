/**
 * Styles for cf-modal component
 *
 * Desktop: Centered modal with fade + scale animation
 * Mobile (<480px): Bottom sheet with slide-up animation
 */
import { css } from "lit";

export const modalStyles = css`
  :host {
    --cf-modal-color-background: var(--cf-theme-color-background, white);
    --cf-modal-color-border: var(--cf-theme-color-border, #e5e7eb);
    --cf-modal-color-surface: var(--cf-theme-color-surface, #fafafa);
    --cf-modal-color-surface-hover: var(
      --cf-theme-color-surface-hover,
      rgba(0, 0, 0, 0.05)
    );
    --cf-modal-color-text: var(--cf-theme-color-text, #111827);
    --cf-modal-color-text-muted: var(--cf-theme-color-text-muted, #6b7280);
    --cf-modal-color-primary: var(--cf-theme-color-primary, #3b82f6);
    --cf-modal-animation-duration: var(--cf-theme-animation-duration, 200ms);
    --cf-modal-border-radius: var(--cf-theme-border-radius, 12px);

    /* CSS custom properties for customization */
    --_backdrop-color: var(--cf-modal-backdrop-color, rgba(0, 0, 0, 0.5));
    --_backdrop-blur: var(--cf-modal-backdrop-blur, 8px);
    --_border-radius: var(--cf-modal-border-radius, 12px);
    --_width-sm: var(--cf-modal-width-sm, 320px);
    --_width-md: var(--cf-modal-width-md, 500px);
    --_width-lg: var(--cf-modal-width-lg, 700px);
    --_max-height: var(--cf-modal-max-height, 90vh);
    --_animation-duration: var(--cf-modal-animation-duration, 200ms);

    display: contents;
  }

  /* ===== Hidden State ===== */
  :host(:not([open])) .backdrop,
  :host(:not([open])) .container {
    visibility: hidden;
    pointer-events: none;
  }

  /* ===== Backdrop ===== */
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--_backdrop-color);
    backdrop-filter: blur(var(--_backdrop-blur));
    -webkit-backdrop-filter: blur(var(--_backdrop-blur));
    opacity: 0;
    transition: opacity var(--_animation-duration) ease;
  }

  :host([open]) .backdrop {
    opacity: 1;
  }

  /* ===== Container (centering) ===== */
  .container {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  /* ===== Dialog ===== */
  .dialog {
    position: relative;
    background: var(--cf-modal-color-background, white);
    border-radius: var(--_border-radius);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    max-height: var(--_max-height);
    overflow: hidden;
    display: flex;
    flex-direction: column;

    /* Desktop: fade + scale animation */
    opacity: 0;
    transform: scale(0.95);
    transition:
      opacity var(--_animation-duration) ease,
      transform var(--_animation-duration) cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    :host([open]) .dialog {
      opacity: 1;
      transform: scale(1);
    }

    /* ===== Size Variants ===== */
    :host([size="sm"]) .dialog {
      width: var(--_width-sm);
    }
    :host([size="md"]) .dialog,
    :host(:not([size])) .dialog {
      width: var(--_width-md);
    }
    :host([size="lg"]) .dialog {
      width: var(--_width-lg);
    }
    :host([size="full"]) .dialog {
      width: calc(100vw - 32px);
      height: calc(100vh - 32px);
      max-height: calc(100vh - 32px);
    }

    /* ===== Header ===== */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--cf-modal-color-border, #e5e7eb);
      background: var(--cf-modal-color-surface, #fafafa);
      flex-shrink: 0;
    }

    .header.empty {
      display: none;
    }

    .header-content {
      font-weight: 600;
      font-size: 16px;
      color: var(--cf-modal-color-text, #111827);
      flex: 1;
      min-width: 0;
    }

    /* ===== Close Button ===== */
    .close-button {
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 4px 8px;
      font-size: 18px;
      color: var(--cf-modal-color-text-muted, #6b7280);
      line-height: 1;
      border-radius: 4px;
      transition: background var(--_animation-duration) ease;
      flex-shrink: 0;
      margin-left: 8px;
    }

    .close-button:hover {
      background: var(--cf-modal-color-surface-hover, rgba(0, 0, 0, 0.05));
    }

    .close-button:focus-visible {
      outline: 2px solid var(--cf-modal-color-primary, #3b82f6);
      outline-offset: 2px;
    }

    :host(:not([dismissable])) .close-button,
    :host([dismissable="false"]) .close-button {
      display: none;
    }

    /* ===== Content ===== */
    .content {
      padding: 20px;
      overflow: auto;
      flex: 1;
    }

    /* ===== Footer ===== */
    .footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 20px;
      border-top: 1px solid var(--cf-modal-color-border, #e5e7eb);
      background: var(--cf-modal-color-surface, #fafafa);
      flex-shrink: 0;
    }

    .footer.empty {
      display: none;
    }

    /* Ensure slotted elements in footer take full width */
    .footer ::slotted(*) {
      width: 100%;
    }

    /* ===== Mobile Bottom Sheet Transformation ===== */
    @media (max-width: 480px) {
      .container {
        align-items: flex-end;
        padding: 0;
      }

      .dialog {
        width: 100%;
        max-height: 85vh;
        border-radius: var(--_border-radius) var(--_border-radius) 0 0;

        /* Mobile: slide up animation instead of scale */
        transform: translateY(100%);
        opacity: 1;
      }

      :host([open]) .dialog {
        transform: translateY(0);
      }

      /* Drag handle indicator for sheet */
      .dialog::before {
        content: "";
        display: block;
        width: 36px;
        height: 4px;
        background: var(--cf-modal-color-border, #e5e7eb);
        border-radius: 2px;
        margin: 8px auto 0;
      }

      /* Adjust header for sheet layout */
      .header {
        padding-top: 8px;
      }

      /* Full width for size variants on mobile */
      :host([size="sm"]) .dialog,
      :host([size="md"]) .dialog,
      :host([size="lg"]) .dialog {
        width: 100%;
      }
    }

    /* ===== Reduced Motion ===== */
    @media (prefers-reduced-motion: reduce) {
      .backdrop,
      .dialog {
        transition: none;
      }
    }
  `;
