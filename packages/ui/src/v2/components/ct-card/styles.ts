/**
 * Styles for ct-card component
 * Based on shadcn/ui card design
 */

export const cardStyles = `
  :host {
    display: block;
    
    /* Default color values if not provided */
    --card: #ffffff;
    --card-foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    --accent: #f1f5f9;
    --accent-foreground: #0f172a;
  }

  .card {
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background-color: var(--card);
    color: var(--card-foreground);
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Clickable card styles */
  :host([clickable]) .card {
    cursor: pointer;
    user-select: none;
  }

  :host([clickable]) .card:hover {
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    transform: translateY(-1px);
  }

  :host([clickable]) .card:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--ring);
  }

  :host([clickable]) .card:active {
    transform: translateY(0);
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }

  /* Card sections */
  .card-header {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 1.5rem;
  }

  .card-header:empty {
    display: none;
  }

  .card-title-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .card-content {
    padding: 0 1.5rem;
    padding-bottom: 1.5rem;
    flex: 1;
  }

  .card-content:first-child {
    padding-top: 1.5rem;
  }

  .card-content:empty {
    display: none;
  }

  .card-footer {
    display: flex;
    align-items: center;
    padding: 1.5rem;
    padding-top: 0;
  }

  .card-footer:empty {
    display: none;
  }

  /* When only content slot is used */
  .card-header:empty + .card-content {
    padding: 1.5rem;
  }

  .card-header:empty + .card-content + .card-footer:empty {
    display: none;
  }

  /* Slot styles */
  ::slotted(*) {
    margin: 0;
  }

  /* Title slot */
  ::slotted([slot="title"]),
  slot[name="title"]::slotted(*) {
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.025em;
  }

  /* Description slot */
  ::slotted([slot="description"]),
  slot[name="description"]::slotted(*) {
    font-size: 0.875rem;
    color: var(--muted-foreground);
    line-height: 1.5;
  }

  /* Action slot */
  ::slotted([slot="action"]),
  slot[name="action"]::slotted(*) {
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Footer slot */
  ::slotted([slot="footer"]),
  slot[name="footer"]::slotted(*) {
    font-size: 0.875rem;
    color: var(--muted-foreground);
  }

  /* Support for data-slot attributes for additional styling hooks */
  ::slotted([data-slot="title"]) {
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.025em;
  }

  ::slotted([data-slot="description"]) {
    font-size: 0.875rem;
    color: var(--muted-foreground);
    line-height: 1.5;
  }

  ::slotted([data-slot="action"]) {
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Responsive adjustments */
  @media (max-width: 640px) {
    .card-header,
    .card-content,
    .card-footer {
      padding: 1rem;
    }

    .card-content:first-child {
      padding-top: 1rem;
    }

    ::slotted([slot="title"]),
    slot[name="title"]::slotted(*),
    ::slotted([data-slot="title"]) {
      font-size: 1.25rem;
    }
  }
`;
