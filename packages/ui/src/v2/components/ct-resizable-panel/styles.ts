export const resizablePanelStyles = `
  :host {
    display: block;
    position: relative;
    overflow: hidden;
    box-sizing: border-box;
  }

  .panel {
    width: 100%;
    height: 100%;
    overflow: auto;
    position: relative;
  }

  /* Custom scrollbar styles */
  .panel::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .panel::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel::-webkit-scrollbar-thumb {
    background-color: rgba(155, 155, 155, 0.5);
    border-radius: 4px;
    border: transparent;
  }

  .panel::-webkit-scrollbar-thumb:hover {
    background-color: rgba(155, 155, 155, 0.7);
  }

  /* Firefox scrollbar */
  .panel {
    scrollbar-width: thin;
    scrollbar-color: rgba(155, 155, 155, 0.5) transparent;
  }
`;
