// NOTE(ja): copied from sidebar.ts ... we need a toasty?
export const toasty = (message: string) => {
  const toastEl = document.createElement("div");
  toastEl.textContent = message;
  toastEl.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    z-index: 1000;
  `;
  document.body.appendChild(toastEl);
  setTimeout(() => toastEl.remove(), 3000);
};
