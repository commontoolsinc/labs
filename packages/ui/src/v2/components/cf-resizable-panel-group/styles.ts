export const resizablePanelGroupStyles = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    position: relative;
  }

  .panel-group {
    display: flex;
    width: 100%;
    height: 100%;
    position: relative;
  }

  .panel-group.direction-horizontal {
    flex-direction: row;
  }

  .panel-group.direction-vertical {
    flex-direction: column;
  }

  :host(.resizing) {
    user-select: none;
  }

  :host(.resizing) * {
    pointer-events: none;
  }

  :host(.resizing) ::slotted(cf-resizable-handle) {
    pointer-events: auto;
  }

  ::slotted(cf-resizable-panel) {
    overflow: hidden;
    position: relative;
  }

  ::slotted(cf-resizable-handle) {
    flex-shrink: 0;
    z-index: 10;
  }

  /* Horizontal layout */
  .panel-group.direction-horizontal ::slotted(cf-resizable-panel) {
    height: 100%;
  }

  .panel-group.direction-horizontal ::slotted(cf-resizable-handle) {
    width: 6px;
    height: 100%;
    cursor: col-resize;
  }

  /* Vertical layout */
  .panel-group.direction-vertical ::slotted(cf-resizable-panel) {
    width: 100%;
  }

  .panel-group.direction-vertical ::slotted(cf-resizable-handle) {
    width: 100%;
    height: 6px;
    cursor: row-resize;
  }
`;
