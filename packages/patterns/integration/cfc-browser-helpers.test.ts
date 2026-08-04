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
});
