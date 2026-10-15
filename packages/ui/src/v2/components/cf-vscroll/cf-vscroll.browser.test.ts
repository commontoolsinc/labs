import { expect } from "@std/expect";
import { CFVScroll } from "./index.ts";

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function rows(count: number): HTMLElement[] {
  return Array.from({ length: count }, (_, i) => {
    const row = document.createElement("div");
    row.style.height = "50px";
    row.textContent = `Row ${i}`;
    return row;
  });
}

function container(element: CFVScroll): HTMLElement {
  return element.shadowRoot!.querySelector(".scroll-container")!;
}

function distanceFromBottom(element: CFVScroll): number {
  const { scrollTop, scrollHeight, clientHeight } = container(element);
  return scrollHeight - clientHeight - scrollTop;
}

/** A 100px-tall snapping scroller, holding `children` when it connects. */
async function mount(children: HTMLElement[]): Promise<CFVScroll> {
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.snapToBottom = true;
  element.height = "100px";
  element.append(...children);
  document.body.append(element);
  expect(element).toBeInstanceOf(CFVScroll);
  await element.updateComplete;
  return element;
}

/**
 * The frames a mutation takes to reach the scroller: the observer's callback
 * runs as a microtask and schedules the snap for the next frame, and an
 * instant snap has landed by the frame after.
 */
async function framesForSnap(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

Deno.test("cf-vscroll snap-to-bottom opens at the bottom when its content is there at connect", async () => {
  const element = await mount(rows(20));
  try {
    expect(container(element).scrollHeight).toBeGreaterThan(100);
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll without snap-to-bottom opens at the top", async () => {
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.height = "100px";
  element.append(...rows(20));
  document.body.append(element);
  try {
    await element.updateComplete;
    await nextFrame();
    expect(container(element).scrollTop).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom jumps, rather than animates, to content that arrives after connect", async () => {
  const element = await mount([]);
  try {
    element.append(...rows(20));
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows content appended while the reader is at the bottom", async () => {
  const element = await mount(rows(20));
  try {
    // Let the opening snap's own scroll events go by first.
    await framesForSnap();
    const settled = new Promise((resolve) =>
      container(element).addEventListener("scrollend", resolve, { once: true })
    );
    element.append(...rows(3));
    expect(distanceFromBottom(element)).toBeGreaterThan(0);
    await settled;
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom holds position when content is appended while the reader has scrolled up", async () => {
  const element = await mount(rows(20));
  try {
    const scrolled = new Promise((resolve) =>
      container(element).addEventListener("scroll", resolve, { once: true })
    );
    container(element).scrollTop = 200;
    await scrolled;
    element.append(...rows(3));
    await framesForSnap();
    expect(container(element).scrollTop).toBe(200);
  } finally {
    element.remove();
  }
});
