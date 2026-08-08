import {
  Browser,
  installPresentationInteractions,
  type Page,
} from "@commonfabric/integration";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  CLICK_TARGET_ATTR,
  clickCfButton,
  clickCfButtonsConcurrently,
  clickNthCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithText } from "./note-button-helpers.ts";

/** One element's live click marks, in attribute order. */
type MarkProbe = { clicks: number; marksAtClick: string[]; marks: string[] };

/** Presentation config with every demo delay removed. */
const testPresentationConfig = {
  enabled: true,
  outputDir: ".",
  videoFileName: "unused.mp4",
  viewport: { width: 1280, height: 720 },
  typingDelayMs: 0,
  cursorTravelMs: 0,
  cursorSettleMs: 0,
  clickPulseMs: 0,
  postResultHoldMs: 0,
  jpegQuality: 85,
  keepFrames: false,
} as const;

describe("CFC browser helpers", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("settles the view before clicking a rendered control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "lp-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __settleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          button.addEventListener("click", () => {
            const input = document.createElement("input");
            input.id = "lp-join-name";
            document.body.append(input);
          }, { once: true });
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#lp-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#lp-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls(),
    }));
    assert(
      result.inputPresent,
      'clicking "Continue as guest" did not reveal #lp-join-name',
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view after clicking so local effects render", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "post-settle-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let clicked = false;
      let settleCalls = 0;
      button.addEventListener("click", () => {
        clicked = true;
      }, { once: true });
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __postSettleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (clicked) {
            const input = document.createElement("input");
            input.id = "post-settle-join-name";
            document.body.append(input);
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#post-settle-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#post-settle-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls(),
    }));
    assert(
      result.inputPresent,
      "the click effect was not applied by a post-click view settle",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view after a late target appears, before clicking it", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      const bind = () => {
        const button = root.querySelector("#late-vote-button");
        if (!button || bound) return;
        bound = true;
        button.addEventListener("click", () => {
          clickedAtSettle = settleCalls;
        }, { once: true });
      };
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!root.querySelector("#late-vote-button")) {
            const button = document.createElement("button");
            button.id = "late-vote-button";
            button.textContent = "Veto";
            root.append(button);
            return Promise.resolve();
          }
          bind();
          return Promise.resolve();
        },
      };

      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickCfButton(page, "#late-vote-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult()
    );
    assert(
      result.clickedAtSettle > 0,
      "the click reached no handler: the view never settled with the target " +
        "present before the click was dispatched",
    );
    // One settle renders the control, one binds it, and one follows the click.
    assertEquals(result.settleCalls, 3);
  });

  it("settles the same rendered control that it clicks", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const createButton = () => {
        const button = document.createElement("button");
        button.id = "replaced-join-button";
        button.textContent = "Join";
        return button;
      };
      root.append(createButton());
      document.body.append(host);

      let settleCalls = 0;
      let clicks = 0;
      let boundButton: HTMLButtonElement | undefined;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (settleCalls === 1) {
            root.replaceChildren(createButton());
          } else {
            const button = root.querySelector<HTMLButtonElement>(
              "#replaced-join-button",
            );
            if (button && button !== boundButton) {
              boundButton = button;
              button.addEventListener("click", () => clicks++);
            }
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).__replacedClickResult = () => ({ settleCalls, clicks });
    });

    await clickCfButton(page, "#replaced-join-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __replacedClickResult: () => {
          settleCalls: number;
          clicks: number;
        };
      }).__replacedClickResult()
    );
    assertEquals(
      result.clicks,
      1,
      "the click reached the replacement before its handler was bound",
    );
    assertEquals(result.settleCalls, 3);
  });

  it("drives the page while waiting for text", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const line = document.createElement("p");
      line.id = "settled-text-line";
      line.textContent = "no votes yet";
      root.append(line);
      document.body.append(host);

      // A rendering the page produces for itself, not one pushed to it. Nothing
      // outside a settle applies it, which is what makes a wait that only
      // watches the DOM sit here until the stuck-condition net fires.
      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (settleCalls >= 2) line.textContent = "3 votes";
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settledTextCalls: () => number;
      }).__settledTextCalls = () => settleCalls;
    });

    await waitForSettledText(page, "#settled-text-line", "3 votes");

    const settleCalls = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __settledTextCalls: () => number;
      }).__settledTextCalls()
    );
    assertEquals(settleCalls, 2);
  });

  it("marks grouped targets between settlement barriers", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      let settleCalls = 0;
      const settleCallsAtClick: number[] = [];
      const createButton = (id: string) => {
        const button = document.createElement("button");
        button.id = id;
        button.textContent = id;
        return button;
      };
      const firstButton = createButton("grouped-button-a");
      const secondButton = createButton("grouped-button-b");
      let secondTargetMarkedAtFirstClick = false;
      firstButton.addEventListener("click", () => {
        if (settleCallsAtClick.length === 0) {
          secondTargetMarkedAtFirstClick = secondButton.hasAttribute(
            clickTargetAttr,
          );
        }
        settleCallsAtClick.push(settleCalls);
      });
      secondButton.addEventListener("click", () => {
        settleCallsAtClick.push(settleCalls);
      }, { once: true });
      root.append(firstButton, secondButton);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult = () => ({
        settleCalls,
        settleCallsAtClick,
        secondTargetMarkedAtFirstClick,
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButtonsConcurrently([
      { page, selector: "#grouped-button-a" },
      { page, selector: "#grouped-button-b" },
      { page, selector: "#grouped-button-a" },
    ]);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult()
    );
    assertEquals(result.settleCallsAtClick, [1, 1, 1]);
    assertEquals(result.settleCalls, 2);
    assert(
      result.secondTargetMarkedAtFirstClick,
      `the second target did not carry ${CLICK_TARGET_ATTR} before dispatch`,
    );
  });

  // Every mark predicate adds its token to the marks already on the element, so
  // a target another click has spoken for keeps that claim. The grouped test
  // above exercises that for the by-selector predicate; these two cover the
  // indexed and trusted-action ones.

  it("keeps a co-resident mark when tagging an indexed target", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const first = document.createElement("button");
      first.className = "indexed-target";
      first.textContent = "first";
      const second = document.createElement("button");
      second.className = "indexed-target";
      second.textContent = "second";
      second.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      second.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(second);
      });
      root.append(first, second);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => unknown;
      }).__indexedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(second),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickNthCfButton(page, ".indexed-target", 1);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => MarkProbe;
      }).__indexedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    // Both marks are live when the click lands, and only this helper's own
    // mark is cleared afterwards.
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });

  it("keeps a co-resident mark when tagging a trusted action", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.setAttribute("data-ui-action", "save-note");
      button.textContent = "Save";
      button.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      button.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(button);
      });
      root.append(button);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => unknown;
      }).__trustedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(button),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickTrustedAction(page, "save-note");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => MarkProbe;
      }).__trustedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });

  // The three tests below cover the click helpers that reach their control by
  // index, by `data-ui-action`, and by button text. Each drives a control that
  // is in the DOM from the start but receives its click handler only when the
  // view settles — the ordinary case of a vdom batch that has not yet crossed
  // to the main thread. A helper that marks its control without settling around
  // it clicks an element with nothing bound, and `clickedAtSettle` stays zero.

  it("settles the view before clicking an indexed control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      for (const label of ["first", "second"]) {
        const button = document.createElement("button");
        button.className = "late-indexed-target";
        button.textContent = label;
        root.append(button);
      }
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            root.querySelectorAll(".late-indexed-target")[1]
              .addEventListener("click", () => {
                clickedAtSettle = settleCalls;
              }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateIndexedResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateIndexedResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickNthCfButton(page, ".late-indexed-target", 1);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateIndexedResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateIndexedResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the indexed target was marked and " +
        "clicked without a settle to bind it",
    );
    // One settle binds the control, and one follows the click.
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view before clicking a trusted action", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.setAttribute("data-ui-action", "late-save");
      button.textContent = "Save";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            button.addEventListener("click", () => {
              clickedAtSettle = settleCalls;
            }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateActionResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateActionResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickTrustedAction(page, "late-save");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateActionResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateActionResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the trusted action was marked and " +
        "clicked without a settle to bind it",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view before clicking a button found by text", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "late-note-button";
      button.textContent = "Publish the late note";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (!bound) {
            bound = true;
            button.addEventListener("click", () => {
              clickedAtSettle = settleCalls;
            }, { once: true });
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __lateNoteResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateNoteResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickButtonWithText(page, "Publish the late note");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateNoteResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateNoteResult()
    );
    assertEquals(
      result.clickedAtSettle,
      1,
      "the click reached no handler: the named button was marked and " +
        "clicked without a settle to bind it",
    );
    assertEquals(result.settleCalls, 2);
  });

  it("drives the page to settle before filling a cf input", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "settling-fill-input";
      Object.assign(host.style, {
        display: "block",
        height: "40px",
        width: "240px",
      });
      const root = host.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      Object.assign(input.style, {
        display: "block",
        height: "32px",
        width: "200px",
      });
      root.append(input);
      document.body.append(host);

      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settlingFillResult: () => { settleCalls: number; value?: string };
      }).__settlingFillResult = () => ({
        settleCalls,
        value: host.shadowRoot?.querySelector("input")?.value,
      });
    });

    await fillCfInput(page, "#settling-fill-input", "Bob");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __settlingFillResult: () => { settleCalls: number; value?: string };
      }).__settlingFillResult()
    );
    assertEquals(result.value, "Bob");
    assert(
      result.settleCalls > 0,
      "the fill read the DOM without asking the view to settle, so it only " +
        "watches the page instead of driving it",
    );
  });

  it("fills a cf input that only pending page work renders", async () => {
    await page.evaluate(() => {
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          if (!document.querySelector("#pending-work-input")) {
            const host = document.createElement("div");
            host.id = "pending-work-input";
            Object.assign(host.style, {
              display: "block",
              height: "40px",
              width: "240px",
            });
            const root = host.attachShadow({ mode: "open" });
            const input = document.createElement("input");
            Object.assign(input.style, {
              display: "block",
              height: "32px",
              width: "200px",
            });
            root.append(input);
            document.body.append(host);
          }
          return Promise.resolve();
        },
      };
    });

    await fillCfInput(page, "#pending-work-input", "Bob");

    const value = await page.evaluate(() =>
      document.querySelector("#pending-work-input")?.shadowRoot
        ?.querySelector("input")?.value
    );
    assertEquals(value, "Bob");
  });

  it("fills the live input when a commit replaces the one it typed into", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div") as HTMLDivElement & {
        commit: () => Promise<void>;
      };
      host.id = "replacing-commit-input";
      Object.assign(host.style, {
        display: "block",
        height: "40px",
        width: "240px",
      });
      const root = host.attachShadow({ mode: "open" });
      const makeInput = () => {
        const input = document.createElement("input");
        Object.assign(input.style, {
          display: "block",
          height: "32px",
          width: "200px",
        });
        return input;
      };
      root.append(makeInput());
      document.body.append(host);

      // The first commit re-renders the control, as a Lit host does when the
      // committed cell value flows back into its template. Later commits leave
      // it in place, so the fill converges on the replacement.
      let replaced = false;
      host.commit = () => {
        if (!replaced) {
          replaced = true;
          root.querySelector("input")?.remove();
          root.append(makeInput());
        }
        return Promise.resolve();
      };

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
    });

    await fillCfInput(page, "#replacing-commit-input", "Bob");

    const value = await page.evaluate(() =>
      document.querySelector("#replacing-commit-input")?.shadowRoot
        ?.querySelector("input")?.value
    );
    assertEquals(value, "Bob");
  });

  it("settles pending page work before presentation typing resolves its input", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        view.id = "pending-presentation-view";
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = {
          viewSettled: () => {
            if (!viewRoot.querySelector("#pending-presentation-input")) {
              const host = document.createElement("div");
              host.id = "pending-presentation-input";
              Object.assign(host.style, {
                display: "block",
                height: "40px",
                width: "240px",
              });
              const root = host.attachShadow({ mode: "open" });
              const input = document.createElement("input");
              Object.assign(input.style, {
                display: "block",
                height: "32px",
                width: "200px",
              });
              root.append(input);
              viewRoot.append(host);
            }
            return Promise.resolve();
          },
        };
      });

      await fillCfInput(presentationPage, "#pending-presentation-input", "Bob");

      const value = await presentationPage.evaluate(() =>
        document.querySelector("#pending-presentation-view")?.shadowRoot
          ?.querySelector("#pending-presentation-input")?.shadowRoot
          ?.querySelector("input")?.value
      );
      assertEquals(value, "Bob");
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  it("drives the page to settle before presentation typing", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        view.id = "settling-presentation-view";
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        const host = document.createElement("div");
        host.id = "settling-presentation-input";
        Object.assign(host.style, {
          display: "block",
          height: "40px",
          width: "240px",
        });
        const root = host.attachShadow({ mode: "open" });
        const input = document.createElement("input");
        Object.assign(input.style, {
          display: "block",
          height: "32px",
          width: "200px",
        });
        root.append(input);
        viewRoot.append(host);

        let settleCalls = 0;
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = {
          viewSettled: () => {
            settleCalls++;
            return Promise.resolve();
          },
        };
        (globalThis as typeof globalThis & {
          __settlingPresentationResult: () => {
            settleCalls: number;
            value?: string;
          };
        }).__settlingPresentationResult = () => ({
          settleCalls,
          value: input.value,
        });
      });

      await fillCfInput(
        presentationPage,
        "#settling-presentation-input",
        "Bob",
      );

      const result = await presentationPage.evaluate(() =>
        (globalThis as typeof globalThis & {
          __settlingPresentationResult: () => {
            settleCalls: number;
            value?: string;
          };
        }).__settlingPresentationResult()
      );
      assertEquals(result.value, "Bob");
      assert(
        result.settleCalls > 0,
        "presentation typing resolved its control without asking the view to " +
          "settle, so it only watches the page instead of driving it",
      );
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  it("reports a control a presentation commit replaced", async () => {
    const presentationPage = await browser.newPage();
    const presentation = installPresentationInteractions(
      presentationPage,
      testPresentationConfig,
      { label: "Bob", color: "#0891b2" },
    );
    try {
      await presentationPage.evaluate(() => {
        // The shell's own controls sit inside shadow roots, so the target hangs
        // off one.
        const view = document.createElement("div");
        const viewRoot = view.attachShadow({ mode: "open" });
        document.body.append(view);
        const host = document.createElement("div") as HTMLDivElement & {
          commit: () => Promise<void>;
        };
        host.id = "replaced-presentation-input";
        Object.assign(host.style, {
          display: "block",
          height: "40px",
          width: "240px",
        });
        const root = host.attachShadow({ mode: "open" });
        const makeInput = () => {
          const input = document.createElement("input");
          Object.assign(input.style, {
            display: "block",
            height: "32px",
            width: "200px",
          });
          return input;
        };
        root.append(makeInput());
        viewRoot.append(host);
        host.commit = () => {
          root.querySelector("input")?.remove();
          root.append(makeInput());
          return Promise.resolve();
        };

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
      });

      // The typed value survives on the detached control, so a verification
      // that reads it reports a fill that never reached the live field.
      const error = await assertRejects(
        () =>
          fillCfInput(presentationPage, "#replaced-presentation-input", "Bob"),
        Error,
      );
      assertStringIncludes(
        (error.cause as Error).message,
        "was replaced while committing",
      );
    } finally {
      presentation.uninstall();
      await presentationPage.close();
    }
  });

  it("waits for a marked target's shifting box to settle before clicking", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "shifting-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let clicked = false;
      button.addEventListener("click", () => {
        clicked = true;
      }, { once: true });

      // The control is laid out when the helper marks it, but its surface then
      // goes display:none for a spell as the join card's entrance settles — the
      // way the real profile surface toggles display through its transition.
      // While the marked control has no layout box, DOM.getBoxModel returns
      // nothing, so a click that measures the box once throws "Unable to get
      // stable box model to click on"; a click that waits for the box to settle
      // clicks the control once its surface returns. The shift lands between the
      // mark and the click, a window with no view settle to sequence against, so
      // the fixture hides on the mark and restores on a timer that outlasts a
      // single mark->click round trip. The restore states when the surface
      // returns, not how long to wait for it: the helper's wait ends on the
      // return, bounded only by the stuck-condition net.
      const observer = new MutationObserver(() => {
        if (!button.hasAttribute(clickTargetAttr)) return;
        observer.disconnect();
        button.style.display = "none";
        setTimeout(() => {
          button.style.display = "";
        }, 1000);
      });
      observer.observe(button, {
        attributes: true,
        attributeFilter: [clickTargetAttr],
      });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __shiftingClicked: () => boolean;
      }).__shiftingClicked = () => clicked;
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButton(page, "#shifting-guest-button");

    const clicked = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __shiftingClicked: () => boolean;
      }).__shiftingClicked()
    );
    assert(
      clicked,
      "the click never reached the target after its hidden surface returned",
    );
  });

  it("clicks a control its surface keeps rebuilding under the aim", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      root.append(surface);
      document.body.append(host);

      let clicked = 0;
      // Listen on the surface, not the control: each rebuild is a different
      // element, and a listener on the control would only ever see the one
      // instance it was attached to.
      surface.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.id === "rebuilt-guest-button") clicked++;
      });

      const makeButton = () => {
        const button = document.createElement("button");
        button.id = "rebuilt-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "32px",
        });
        return button;
      };
      surface.append(makeButton());

      // Once the helper marks the control, the surface rebuilds it on every
      // animation frame, the way a piece re-render replaces the DOM it drew
      // while a test is already interacting with it. Each replacement is
      // geometrically identical, so what changes is which element is there,
      // not where a click has to land. The mark travels to the replacement,
      // which is what a helper addressing the control by name would find.
      //
      // A click that resolves the control to a handle up front and measures
      // that handle's box some protocol round trips later measures an element
      // the surface has since dropped, and reports "Unable to get stable box
      // model to click on". A click that decides and measures inside one page
      // turn measures whichever element is there at that instant, and lands.
      const observer = new MutationObserver(() => {
        if (!surface.querySelector(`[${clickTargetAttr}]`)) return;
        observer.disconnect();
        let framesLeft = 20;
        const rebuild = () => {
          const current = surface.querySelector("#rebuilt-guest-button");
          if (!current || framesLeft-- <= 0) return;
          const replacement = makeButton();
          for (const name of current.getAttributeNames()) {
            replacement.setAttribute(name, current.getAttribute(name)!);
          }
          current.replaceWith(replacement);
          requestAnimationFrame(rebuild);
        };
        requestAnimationFrame(rebuild);
      });
      observer.observe(surface, {
        attributes: true,
        subtree: true,
        attributeFilter: [clickTargetAttr],
      });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __rebuiltClicks: () => number;
      }).__rebuiltClicks = () => clicked;
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButton(page, "#rebuilt-guest-button");

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __rebuiltClicks: () => number;
      }).__rebuiltClicks()
    );
    assertEquals(
      clicks,
      1,
      "the click never reached the control the surface rebuilt under it",
    );
  });

  it("clicks the control its surface relaid out under the aim", async () => {
    // The aim measures the control inside the page and hands the point back to
    // the test process, which then dispatches the trusted click over a separate
    // protocol round trip. The page runs freely across that gap. A re-render
    // arriving in it — a roster update crossing from another browser, say —
    // relays the surface out and carries the control away from the point the
    // click is already aimed at, so the click lands on whatever moved into that
    // space and the control is never clicked.
    //
    // The relayout is driven from the interaction observer's `beforeClick`,
    // which the dispatch awaits, so it lands strictly between the measurement
    // and the click with no timing to align. It fires once: the second aim
    // measures the control where it now sits, and the click that follows has
    // nothing left to move it.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      // Fixed and on screen, so the aim's scroll cannot move it and the
      // content earlier cases leave on the shared page cannot reach it.
      Object.assign(surface.style, {
        position: "fixed",
        left: "400px",
        top: "300px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      // The block that grows into the space the control vacates. A click that
      // went to the control's old point landed here, which is what tells the
      // two failures apart: a click that reached nothing at all, and a click
      // that reached the wrong control.
      const filler = document.createElement("button");
      filler.id = "relaid-out-filler";
      Object.assign(filler.style, {
        display: "block",
        width: "200px",
        height: "0px",
        padding: "0",
        margin: "0",
        border: "none",
      });
      const button = document.createElement("button");
      button.id = "relaid-out-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(filler, button);

      let buttonClicks = 0;
      let fillerClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      filler.addEventListener("click", () => void fillerClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __relaidOutRelayout: () => void;
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutRelayout = () => {
        // 100px of filler covers the whole 40px box the control has left.
        filler.style.height = "100px";
      };
      (globalThis as typeof globalThis & {
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutClicks = () => ({
        button: buttonClicks,
        filler: fillerClicks,
      });
    });

    let relaidOut = false;
    page.setInteractionObserver({
      beforeClick: async () => {
        if (relaidOut) return;
        relaidOut = true;
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __relaidOutRelayout: () => void;
          }).__relaidOutRelayout()
        );
      },
    });
    try {
      await clickCfButton(page, "#relaid-out-guest-button");
    } finally {
      page.setInteractionObserver(undefined);
    }

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __relaidOutClicks: () => { button: number; filler: number };
      }).__relaidOutClicks()
    );
    assertEquals(
      clicks,
      { button: 1, filler: 0 },
      "the click did not reach the control after its surface relaid out",
    );
  });

  it("clicks the control its surface moved between press and release", async () => {
    // A trusted click is a press and a release, dispatched over two protocol
    // round trips. A surface that relays out between them leaves the release
    // somewhere the press was not, and the browser raises the click on the
    // nearest ancestor the two have in common rather than on the control. The
    // control is never clicked.
    //
    // The relayout is driven from the control's own mousedown, so it lands
    // strictly between the two dispatches with no timing to align. It fires
    // once, so the click that follows has a control standing still to reach.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "400px",
        top: "80px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      const filler = document.createElement("div");
      Object.assign(filler.style, { display: "block", height: "0px" });
      const button = document.createElement("button");
      button.id = "split-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(filler, button);

      let buttonClicks = 0;
      let strayClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      // Clicks the browser raised somewhere other than the control. The one a
      // split press and release produces lands here, on the surface the two
      // targets have in common.
      surface.addEventListener("click", (event) => {
        if (event.target !== button) strayClicks++;
      });
      button.addEventListener("mousedown", () => {
        filler.style.height = "100px";
      }, { once: true });

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __splitClicks: () => { button: number; stray: number };
      }).__splitClicks = () => ({ button: buttonClicks, stray: strayClicks });
    });

    await clickCfButton(page, "#split-guest-button");

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __splitClicks: () => { button: number; stray: number };
      }).__splitClicks()
    );
    assertEquals(
      clicks,
      { button: 1, stray: 0 },
      "the click did not reach the control after the press and release split",
    );
  });

  it("leaves the page's own clicks to the page while a click is in flight", async () => {
    // Components raise clicks of their own — a label forwarding to its control,
    // a component clicking itself from a key handler. One of those arriving
    // while a trusted click is crossing the protocol is not that click, and is
    // none of the helper's business: it must reach its own listeners, and it
    // must not answer for the interaction the helper is waiting on.
    //
    // The page's click is raised from the interaction observer's `beforeClick`,
    // which the dispatch awaits, so it lands in exactly that window.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "700px",
        top: "300px",
        width: "220px",
      });
      root.append(surface);
      document.body.append(host);

      const elsewhere = document.createElement("button");
      elsewhere.id = "page-raised-elsewhere";
      const button = document.createElement("button");
      button.id = "page-raised-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      surface.append(elsewhere, button);

      let buttonClicks = 0;
      let elsewhereClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);
      elsewhere.addEventListener("click", () => void elsewhereClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __pageRaisedClick: () => void;
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClick = () => elsewhere.click();
      (globalThis as typeof globalThis & {
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClicks = () => ({
        button: buttonClicks,
        elsewhere: elsewhereClicks,
      });
    });

    let raised = false;
    page.setInteractionObserver({
      beforeClick: async () => {
        if (raised) return;
        raised = true;
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            __pageRaisedClick: () => void;
          }).__pageRaisedClick()
        );
      },
    });
    try {
      await clickCfButton(page, "#page-raised-guest-button");
    } finally {
      page.setInteractionObserver(undefined);
    }

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __pageRaisedClicks: () => { button: number; elsewhere: number };
      }).__pageRaisedClicks()
    );
    assertEquals(
      clicks,
      { button: 1, elsewhere: 1 },
      "the page's own click was swallowed, or answered for the trusted one",
    );
  });

  it("reports a control that keeps taking the click nowhere", async () => {
    // A control a click cannot reach — covered, or declining pointer events —
    // is aimed at, missed, and aimed at again in the same place. The second aim
    // repeats a pixel a dispatch already lost, which is where the helper stops
    // and says so, rather than dispatching at it forever.
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const surface = document.createElement("div");
      Object.assign(surface.style, {
        position: "fixed",
        left: "700px",
        top: "80px",
        width: "220px",
        height: "40px",
      });
      root.append(surface);
      document.body.append(host);

      const button = document.createElement("button");
      button.id = "unreachable-guest-button";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        display: "block",
        width: "200px",
        height: "40px",
        padding: "0",
        margin: "0",
      });
      const cover = document.createElement("div");
      Object.assign(cover.style, {
        position: "absolute",
        inset: "0",
      });
      surface.append(button, cover);

      let buttonClicks = 0;
      button.addEventListener("click", () => void buttonClicks++);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = { viewSettled: () => Promise.resolve() };
      (globalThis as typeof globalThis & {
        __unreachableClicks: () => number;
      }).__unreachableClicks = () => buttonClicks;
    });

    const error = await assertRejects(
      () => clickCfButton(page, "#unreachable-guest-button"),
      Error,
    );
    assertStringIncludes(
      error.message,
      "again, where a trusted click already failed to reach it",
    );

    const clicks = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __unreachableClicks: () => number;
      }).__unreachableClicks()
    );
    assertEquals(clicks, 0, "the covered control should have taken no click");
  });

  it("tells the interaction observer where a marked click landed", async () => {
    // A presentation recording animates its cursor from these callbacks. The
    // click is aimed at a point rather than resolved to a handle, so the
    // observer is told about a point with no element to name.
    const observed: { phase: string; x: number; y: number }[] = [];
    page.setInteractionObserver({
      beforeClick: (_element, point) =>
        void observed.push({ phase: "before", x: point.x, y: point.y }),
      afterClick: (_element, point) =>
        void observed.push({ phase: "after", x: point.x, y: point.y }),
    });
    try {
      await page.evaluate(() => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.id = "observed-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          position: "fixed",
          left: "40px",
          top: "40px",
          width: "120px",
          height: "40px",
          margin: "0",
        });
        root.append(button);
        document.body.append(host);
        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
      });

      await clickCfButton(page, "#observed-guest-button");

      assertEquals(
        observed.map((entry) => entry.phase),
        ["before", "after"],
        "the observer should bracket the click",
      );
      // The control sits at 40,40 and is 120x40, so its centre is 100,60.
      assertEquals({ x: observed[0].x, y: observed[0].y }, { x: 100, y: 60 });
      assertEquals({ x: observed[1].x, y: observed[1].y }, { x: 100, y: 60 });
    } finally {
      page.setInteractionObserver(undefined);
    }
  });

  it("clicks a control on a page that is not being rendered", async () => {
    // A page sharing a browser with a fronted page is hidden, and a hidden page
    // produces no animation frames. A settle that waits for a frame there waits
    // for one that never arrives, and a settle that yields only to the
    // microtask queue starves the timers and tasks that would bring a
    // momentarily hidden control back — so it spins against a control it is
    // itself preventing from returning. Both leave the click unable to land.
    const background = await browser.newPage();
    const fronted = await browser.newPage();
    try {
      assertEquals(
        await background.evaluate(() => document.visibilityState),
        "hidden",
        "the background page should not be rendering",
      );

      await background.evaluate((clickTargetAttr: string) => {
        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.id = "background-guest-button";
        button.textContent = "Continue as guest";
        Object.assign(button.style, {
          display: "block",
          width: "200px",
          height: "32px",
        });
        root.append(button);
        document.body.append(host);

        let clicked = 0;
        button.addEventListener("click", () => {
          clicked++;
        });

        // The control goes away for a spell once marked and comes back on a
        // task. Only a settle that lets the event loop turn will ever see it
        // return.
        const observer = new MutationObserver(() => {
          if (!button.hasAttribute(clickTargetAttr)) return;
          observer.disconnect();
          button.style.display = "none";
          setTimeout(() => {
            button.style.display = "block";
          }, 250);
        });
        observer.observe(button, {
          attributes: true,
          attributeFilter: [clickTargetAttr],
        });

        (globalThis as typeof globalThis & {
          commonfabric: { viewSettled: () => Promise<void> };
        }).commonfabric = { viewSettled: () => Promise.resolve() };
        (globalThis as typeof globalThis & {
          __backgroundClicks: () => number;
        }).__backgroundClicks = () => clicked;
      }, { args: [CLICK_TARGET_ATTR] });

      await clickCfButton(background, "#background-guest-button");

      const clicks = await background.evaluate(() =>
        (globalThis as typeof globalThis & {
          __backgroundClicks: () => number;
        }).__backgroundClicks()
      );
      assertEquals(
        clicks,
        1,
        "the click never landed on the unrendered page's control",
      );
    } finally {
      await fronted.close();
      await background.close();
    }
  });
});
