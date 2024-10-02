import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  setTransitions,
  transition,
  durationMd,
  easeOutExpoCss,
  easeOutCubicCss,
} from "../shared/animation.js";

@customElement("os-navstack")
export class OsNavstack extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .navstack {
      width: 100%;
      height: 100%;
      position: relative;
    }

    .navstack-root {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1;
    }

    .navstack-panels {
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      position: absolute;
      z-index: 2;
      pointer-events: none;

      > * {
        overflow-x: hidden;
        overflow-y: scroll;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: all;
      }
    }
  `;

  @property({ type: Array<HTMLElement> })
  panels: Array<HTMLElement> = [];

  override render() {
    const onNavBack = (_: NavBackEvent) => {
      this.back();
    };

    return html`
      <div @navback=${onNavBack} class="navstack">
        <div class="navstack-root">
          <slot></slot>
        </div>
        <div class="navstack-panels">${this.panels}</div>
      </div>
    `;
  }

  async back() {
    const panels = [...this.panels];
    let lastPanel = panels.at(-1);
    if (!lastPanel) {
      return;
    }
    await setTransitions(lastPanel, [
      transition({
        property: "left",
        duration: durationMd,
        easing: easeOutCubicCss,
        to: `480px`,
      }),
      transition({
        property: "opacity",
        duration: durationMd,
        delay: 100,
        easing: easeOutExpoCss,
        to: `0`,
      }),
    ]);
    panels.pop();
    this.panels = panels;
  }
}

/**
 * Custom event for back in a navigational context
 */
export class NavBackEvent extends Event {
  constructor() {
    super("navback", { bubbles: true, composed: true });
  }
}

@customElement("os-nav-back-button")
export class OsNavBackButton extends LitElement {
  static override styles = [
    css`
      :host {
        display: block;
        width: fit-content;
        height: fit-content;
      }
    `,
  ];

  override render() {
    const onClick = () => {
      this.dispatchEvent(new NavBackEvent());
    };

    return html`<os-icon-button
      @click="${onClick}"
      icon="arrow_back"
    ></os-icon-button>`;
  }
}
