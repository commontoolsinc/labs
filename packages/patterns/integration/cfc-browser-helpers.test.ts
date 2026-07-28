import { Browser, type Page } from "@commonfabric/integration";
import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  CLICK_TARGET_ATTR,
  clickCfButton,
  clickCfButtonsConcurrently,
  clickNthCfButton,
  clickTrustedAction,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";

/** One element's live click marks, in attribute order. */
type MarkProbe = { clicks: number; marksAtClick: string[]; marks: string[] };

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
      // The shell binds a control's handler when the vdom batch that rendered
      // it is applied, which is one of the things a view settle waits for. So
      // the handler here is bound by the first settle that runs with the
      // control present, and a click delivered before that reaches nothing.
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
          bind();
          return Promise.resolve();
        },
      };

      // The control arrives after the helper has started, the way an option
      // card added by one browser reaches another. The delay states when the
      // arrival happens rather than how long to wait for it: the helper's wait
      // ends on the arrival, and only the five-minute stuck-condition net
      // bounds it. What the delay has to outlast is one settle on the ordering
      // this test guards against, which is a single protocol round trip.
      setTimeout(() => {
        const button = document.createElement("button");
        button.id = "late-vote-button";
        button.textContent = "Veto";
        root.append(button);
      }, 250);

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
    // One settle found no control, one found it, and one followed the click.
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
});
