import { assert, assertAlmostEquals, assertLessOrEqual } from "@std/assert";
import "./index.ts";

type UpdatingModal = HTMLElement & {
  open: boolean;
  preventScroll: boolean;
  updateComplete: Promise<unknown>;
};

type ModalVariant = {
  name: string;
  attributes: Record<string, string>;
  viewportMaxHeight: (viewportHeight: number) => number;
};

type MountedModal = {
  fixture: HTMLElement;
  modalContainer: HTMLElement;
  dialog: HTMLElement;
  content: HTMLElement;
  footerButton: HTMLElement;
};

const VARIANTS: ModalVariant[] = [
  {
    name: "dialog",
    attributes: {},
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.9,
  },
  {
    name: "full-size dialog",
    attributes: { size: "full" },
    viewportMaxHeight: (viewportHeight) => viewportHeight - 32,
  },
  {
    name: "automatic sheet",
    attributes: { presentation: "sheet" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.9,
  },
  {
    name: "half sheet",
    attributes: { presentation: "sheet", detent: "half" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.5,
  },
  {
    name: "full sheet",
    attributes: { presentation: "sheet", detent: "full" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.92,
  },
];

async function settleLayout(element: UpdatingModal): Promise<void> {
  await element.updateComplete;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await element.updateComplete;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function requiredElement(
  root: ParentNode,
  selector: string,
): HTMLElement {
  const element = root.querySelector(selector);
  assert(
    element instanceof HTMLElement,
    `Expected ${selector} to be an HTMLElement`,
  );
  return element;
}

async function mountModal(
  variant: ModalVariant,
  fixtureHeight: string,
  customMaxHeight?: string,
): Promise<MountedModal> {
  const fixture = document.createElement("div");
  fixture.style.cssText = [
    "position: fixed",
    "inset: 24px auto auto 24px",
    "width: 640px",
    `height: ${fixtureHeight}`,
    "transform: translateZ(0)",
    "overflow: hidden",
  ].join(";");
  document.body.append(fixture);

  try {
    const modal = document.createElement("cf-modal") as UpdatingModal;
    modal.open = true;
    modal.preventScroll = false;
    modal.style.setProperty("--cf-modal-animation-duration", "0ms");
    modal.style.setProperty("--cf-modal-border", "4px solid transparent");
    if (customMaxHeight) {
      modal.style.setProperty("--cf-modal-max-height", customMaxHeight);
    }
    for (const [name, value] of Object.entries(variant.attributes)) {
      modal.setAttribute(name, value);
    }
    modal.innerHTML = `
      <span slot="header">Review command</span>
      <div style="height: 10000px">Command data</div>
      <button slot="footer" type="button">Send command</button>
    `;
    fixture.append(modal);
    await settleLayout(modal);

    const shadowRoot = modal.shadowRoot;
    assert(shadowRoot);
    return {
      fixture,
      modalContainer: requiredElement(shadowRoot, ".container"),
      dialog: requiredElement(shadowRoot, ".dialog"),
      content: requiredElement(shadowRoot, ".content"),
      footerButton: requiredElement(modal, '[slot="footer"]'),
    };
  } catch (error) {
    fixture.remove();
    throw error;
  }
}

function assertContained(
  variant: ModalVariant,
  mounted: MountedModal,
): void {
  const fixtureRect = mounted.fixture.getBoundingClientRect();
  const containerRect = mounted.modalContainer.getBoundingClientRect();
  const dialogRect = mounted.dialog.getBoundingClientRect();
  const footerButtonRect = mounted.footerButton.getBoundingClientRect();
  const containerStyle = getComputedStyle(mounted.modalContainer);
  const contentTop = containerRect.top +
    Number.parseFloat(containerStyle.paddingTop);
  const contentBottom = containerRect.bottom -
    Number.parseFloat(containerStyle.paddingBottom);
  const contentLeft = containerRect.left +
    Number.parseFloat(containerStyle.paddingLeft);
  const contentRight = containerRect.right -
    Number.parseFloat(containerStyle.paddingRight);

  assertAlmostEquals(containerRect.top, fixtureRect.top, 0.5);
  assertAlmostEquals(containerRect.bottom, fixtureRect.bottom, 0.5);
  assertAlmostEquals(containerRect.left, fixtureRect.left, 0.5);
  assertAlmostEquals(containerRect.right, fixtureRect.right, 0.5);
  assert(
    dialogRect.left >= contentLeft - 0.5,
    `${variant.name}: dialog left ${dialogRect.left}, ` +
      `content left ${contentLeft}`,
  );
  assertLessOrEqual(
    dialogRect.right,
    contentRight + 0.5,
    `${variant.name}: dialog right ${dialogRect.right}, ` +
      `content right ${contentRight}`,
  );
  assert(
    dialogRect.top >= contentTop - 0.5,
    `${variant.name}: dialog top ${dialogRect.top}, content top ${contentTop}`,
  );
  assertLessOrEqual(
    dialogRect.bottom,
    contentBottom + 0.5,
    `${variant.name}: dialog bottom ${dialogRect.bottom}, ` +
      `content bottom ${contentBottom}`,
  );
  if (variant.attributes.presentation === "sheet") {
    assertAlmostEquals(dialogRect.left, contentLeft, 0.5);
    assertAlmostEquals(dialogRect.right, contentRight, 0.5);
  }
  assert(
    footerButtonRect.width > 0 && footerButtonRect.height > 0,
    `${variant.name}: footer control should be visible`,
  );
  assert(
    footerButtonRect.left >= dialogRect.left - 0.5,
    `${variant.name}: footer control left ${footerButtonRect.left}, ` +
      `dialog left ${dialogRect.left}`,
  );
  assertLessOrEqual(
    footerButtonRect.right,
    dialogRect.right + 0.5,
    `${variant.name}: footer control right ${footerButtonRect.right}, ` +
      `dialog right ${dialogRect.right}`,
  );
  assert(
    footerButtonRect.top >= dialogRect.top - 0.5,
    `${variant.name}: footer control top ${footerButtonRect.top}, ` +
      `dialog top ${dialogRect.top}`,
  );
  assertLessOrEqual(
    footerButtonRect.bottom,
    dialogRect.bottom + 0.5,
    `${variant.name}: footer control bottom ${footerButtonRect.bottom}, ` +
      `dialog bottom ${dialogRect.bottom}`,
  );
  assert(
    mounted.content.scrollHeight > mounted.content.clientHeight,
    `${variant.name}: content should scroll inside the dialog`,
  );
}

for (const variant of VARIANTS) {
  Deno.test(`${variant.name} stays inside its fixed-position containing block`, async () => {
    if (typeof document === "undefined") return;

    const mounted = await mountModal(variant, "320px");
    try {
      assertContained(variant, mounted);
    } finally {
      mounted.fixture.remove();
    }
  });

  Deno.test(`${variant.name} preserves its viewport height limit`, async () => {
    if (typeof document === "undefined") return;

    const mounted = await mountModal(variant, "200vh");
    try {
      const dialogHeight = mounted.dialog.getBoundingClientRect().height;
      const expectedHeight = variant.viewportMaxHeight(innerHeight);
      assertAlmostEquals(
        dialogHeight,
        expectedHeight,
        0.5,
        `${variant.name}: height ${dialogHeight}, expected ${expectedHeight}`,
      );
      assert(
        mounted.content.scrollHeight > mounted.content.clientHeight,
        `${variant.name}: content should reach the height limit`,
      );
    } finally {
      mounted.fixture.remove();
    }
  });
}

Deno.test("dialog preserves a custom maximum height", async () => {
  if (typeof document === "undefined") return;

  const mounted = await mountModal(VARIANTS[0], "320px", "180px");
  try {
    assertAlmostEquals(
      mounted.dialog.getBoundingClientRect().height,
      180,
      0.5,
    );
    assertContained(VARIANTS[0], mounted);
  } finally {
    mounted.fixture.remove();
  }
});
