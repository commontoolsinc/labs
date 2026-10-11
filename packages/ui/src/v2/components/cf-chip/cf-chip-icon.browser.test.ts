/**
 * A chip's icon slot takes room only while an icon is slotted: without one,
 * the label starts where the chip's content starts, with no gap before it; an
 * icon added or removed later shows or hides that room, in both the plain and
 * the interactive chip.
 */

import { expect } from "@std/expect";

import { CFChip } from "./index.ts";

/** A chip in the page, removed again on disposal. */
async function mounted(
  options: { icon?: boolean; interactive?: boolean } = {},
): Promise<CFChip & Disposable> {
  const chip = new CFChip();
  chip.label = "Label";
  chip.interactive = options.interactive ?? false;
  if (options.icon) chip.append(icon());
  document.body.append(chip);
  await settled(chip);
  return Object.assign(chip, { [Symbol.dispose]: () => chip.remove() });
}

function icon(): HTMLElement {
  const element = document.createElement("span");
  element.slot = "icon";
  element.textContent = "*";
  return element;
}

/**
 * Waits out a slot change and the render it causes. Both run in microtasks of
 * the task that changed the children, so they are done by the next frame.
 */
async function settled(chip: CFChip): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await chip.updateComplete;
}

/** How far the label starts past the start of the chip's content box. */
function labelInset(chip: CFChip): number {
  const box = chip.shadowRoot?.querySelector(".chip");
  const label = chip.shadowRoot?.querySelector(".chip-label");
  if (!box || !label) throw new Error("the chip did not render");
  const style = getComputedStyle(box);
  const contentStart = box.getBoundingClientRect().left +
    parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  return label.getBoundingClientRect().left - contentStart;
}

/** Whether the icon slot lays out a box. */
function iconShown(chip: CFChip): boolean {
  const slot = chip.shadowRoot?.querySelector('slot[name="icon"]');
  if (!slot) throw new Error("the chip did not render");
  return getComputedStyle(slot).display !== "none";
}

for (const interactive of [false, true]) {
  const kind = interactive ? "an interactive chip" : "a chip";

  Deno.test(`${kind} without an icon starts its label with no gap`, async () => {
    using chip = await mounted({ interactive });
    expect(iconShown(chip)).toBe(false);
    expect(labelInset(chip)).toBe(0);
  });

  Deno.test(`${kind} with an icon shows it before the label`, async () => {
    using chip = await mounted({ icon: true, interactive });
    expect(iconShown(chip)).toBe(true);
    expect(labelInset(chip)).toBeGreaterThan(0);
  });

  Deno.test(`${kind} shows an icon added later, and hides it once removed`, async () => {
    using chip = await mounted({ interactive });
    const added = icon();
    chip.append(added);
    await settled(chip);
    expect(iconShown(chip)).toBe(true);
    expect(labelInset(chip)).toBeGreaterThan(0);
    added.remove();
    await settled(chip);
    expect(iconShown(chip)).toBe(false);
    expect(labelInset(chip)).toBe(0);
  });
}

Deno.test("a chip keeps its icon when it turns interactive", async () => {
  using chip = await mounted({ icon: true });
  chip.interactive = true;
  await settled(chip);
  expect(iconShown(chip)).toBe(true);
  expect(labelInset(chip)).toBeGreaterThan(0);
});
