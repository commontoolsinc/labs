/**
 * Styles for ct-slider component
 */

export const sliderStyles = `
  :host {
    display: inline-block;
    width: 100%;
    min-width: 200px;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
    --primary: #3b82f6;
    --primary-foreground: #ffffff;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    
    /* Slider dimensions */
    --slider-height: 1.25rem;
    --track-height: 0.5rem;
    --thumb-size: 1.25rem;
    --slider-border-radius: 9999px;
  }

  :host([orientation="vertical"]) {
    width: var(--slider-height);
    height: 200px;
    min-width: var(--slider-height);
    min-height: 200px;
  }

  * {
    box-sizing: border-box;
  }

  .slider {
    position: relative;
    width: 100%;
    height: var(--slider-height);
    display: flex;
    align-items: center;
    touch-action: none;
    user-select: none;
  }

  .slider.vertical {
    width: var(--slider-height);
    height: 100%;
    align-items: center;
    justify-content: center;
  }

  .slider.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Track */
  .track {
    position: relative;
    width: 100%;
    height: var(--track-height);
    background-color: var(--border);
    border-radius: var(--slider-border-radius);
    overflow: hidden;
    cursor: pointer;
  }

  .slider.vertical .track {
    width: var(--track-height);
    height: 100%;
  }

  .slider.disabled .track {
    cursor: not-allowed;
  }

  /* Range (filled portion) */
  .range {
    position: absolute;
    height: 100%;
    background-color: var(--primary);
    border-radius: var(--slider-border-radius);
    pointer-events: none;
  }

  .slider.horizontal .range {
    left: 0;
    top: 0;
  }

  .slider.vertical .range {
    bottom: 0;
    left: 0;
    width: 100%;
  }

  /* Thumb */
  .thumb {
    position: absolute;
    width: var(--thumb-size);
    height: var(--thumb-size);
    background-color: var(--background);
    border: 2px solid var(--primary);
    border-radius: var(--slider-border-radius);
    cursor: grab;
    transform: translate(-50%, -50%);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1);
  }

  .slider.horizontal .thumb {
    top: 50%;
  }

  .slider.vertical .thumb {
    left: 50%;
    transform: translate(-50%, 50%);
  }

  .slider.disabled .thumb {
    cursor: not-allowed;
    border-color: var(--border);
  }

  /* Hover state */
  :host(:not([disabled]):hover) .thumb {
    border-color: var(--primary);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
  }

  /* Focus state */
  :host(:focus) {
    outline: none;
  }

  :host(:focus-visible) .thumb {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--ring);
  }

  /* Active/dragging state */
  :host(.dragging) .thumb,
  .thumb:active {
    cursor: grabbing;
    transform: translate(-50%, -50%) scale(1.1);
  }

  .slider.vertical .thumb:active,
  :host(.dragging) .slider.vertical .thumb {
    transform: translate(-50%, 50%) scale(1.1);
  }

  /* Touch target enhancement */
  .thumb::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 2.5rem;
    height: 2.5rem;
    transform: translate(-50%, -50%);
  }

  /* Transitions */
  .range {
    transition: width 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .slider.vertical .range {
    transition: height 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Smooth thumb movement during drag */
  :host(.dragging) .thumb {
    transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* High contrast mode support */
  @media (prefers-contrast: high) {
    .track {
      border: 1px solid;
    }

    .thumb {
      border-width: 3px;
    }
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .thumb,
    .range {
      transition: none;
    }
  }

  /* Dark mode support (when CSS variables are updated) */
  @media (prefers-color-scheme: dark) {
    :host {
      --background: #0f172a;
      --foreground: #f8fafc;
      --border: #334155;
      --ring: #64748b;
      --primary: #60a5fa;
      --primary-foreground: #0f172a;
      --muted: #1e293b;
      --muted-foreground: #94a3b8;
    }
  }
`;
