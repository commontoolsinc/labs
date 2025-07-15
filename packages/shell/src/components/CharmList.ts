import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseView } from "../views/BaseView.ts";
import { CharmsController } from "@commontools/charm/ops";
import { Task } from "@lit/task";
import { getNavigationHref, navigateToCharm } from "../lib/navigate.ts";
import type { RuntimeProgram } from "@commontools/runner";
import { processSchema } from "@commontools/charm";

export class XCharmListElement extends BaseView {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background-color: white;
      padding: 1rem;
    }
  `;

  // Track charm creation in progress to prevent duplicates
  private static creatingCharms = new Map<string, Promise<void>>();

  @property({ attribute: false })
  cc?: CharmsController;

  private _charmList = new Task(this, {
    task: async ([cc]) => {
      if (!cc) return undefined;

      // Ensure charms are synced before checking
      const manager = cc.manager();
      await manager.synced();

      const charms = await cc.getAllCharms();
      console.log(`[CharmList] Found ${charms.length} charms after syncing`);

      // Check if we already have a DefaultCharmList charm
      const defaultCharmList = charms.find((charm) => {
        const name = charm.name();
        console.log(`[CharmList] Checking charm ${charm.id}: name="${name}"`);
        return name && name.startsWith("DefaultCharmList");
      });

      if (defaultCharmList) {
        console.log(
          `[CharmList] Found existing DefaultCharmList: ${defaultCharmList.id}`,
        );
        // Set the activeCharmId but don't update the URL
        // This will cause Body to render the charm without changing the URL
        app.setActiveCharmId(defaultCharmList.id);
        return undefined;
      }

      console.log(`[CharmList] No DefaultCharmList found, creating new one...`);
      // If no DefaultCharmList exists (whether space is empty or not), create one
      await this.createDefaultCharm(cc);
      // Don't return anything, let the navigation handle the update
      return undefined;
    },
    args: () => [this.cc],
  });

  private async createDefaultCharm(cc: CharmsController) {
    const spaceName = cc.manager().getSpaceName();

    // Check if creation is already in progress for this space
    const existingCreation = XCharmListElement.creatingCharms.get(spaceName);
    if (existingCreation) {
      // Wait for the existing creation to complete
      await existingCreation;
      return;
    }

    // Create a promise for this creation attempt
    const creationPromise = this.doCreateDefaultCharm(cc);
    XCharmListElement.creatingCharms.set(spaceName, creationPromise);

    try {
      await creationPromise;
    } finally {
      // Clean up the promise from the map
      XCharmListElement.creatingCharms.delete(spaceName);
    }
  }

  private async doCreateDefaultCharm(cc: CharmsController) {
    try {
      const manager = cc.manager();
      const runtime = manager.runtime;
      const spaceName = manager.getSpaceName();

      // Load the charm-list recipe from static cache
      const recipeContent = await runtime.staticCache.getText(
        "recipes/charm-list.tsx",
      );

      // Create RuntimeProgram
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: recipeContent }],
      };

      // Create the charm (no initial input needed)
      const charm = await cc.create(program);
      console.log(`[CharmList] Created new charm: ${charm.id}`);

      // Check the charm's name immediately after creation
      const charmName = charm.name();
      console.log(`[CharmList] New charm name: "${charmName}"`);

      // Link the well-known allCharms cell to the charm's input
      const allCharmsId =
        "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";

      // Create a transaction and use withTx to wrap the link operation
      const tx = runtime.edit();

      // Get the charm cell and wrap it with the transaction
      const charmCell = await manager.get(charm.id);
      const sourceCell = charmCell.getSourceCell(processSchema);

      if (sourceCell) {
        // Get the well-known allCharms cell using its EntityId format
        const allCharmsCell = await manager.getCellById({ "/": allCharmsId });
        sourceCell.withTx(tx).key("argument").key("allCharms").set(
          allCharmsCell.withTx(tx),
        );
        await tx.commit();
      }

      // Wait for the link to be processed
      await runtime.idle();
      await manager.synced();

      // Double-check: see if another DefaultCharmList was created while we were creating ours
      const allCharms = await cc.getAllCharms();
      const existingDefaultCharm = allCharms.find((c) => {
        const name = c.name();
        return name && name.startsWith("DefaultCharmList") && c.id !== charm.id;
      });

      if (existingDefaultCharm) {
        // Another one was created, use that one instead
        app.setActiveCharmId(existingDefaultCharm.id);
      } else {
        // Set the activeCharmId directly instead of navigating
        // This shows the DefaultCharmList without updating the URL
        app.setActiveCharmId(charm.id);
      }
    } catch (error) {
      console.error("Failed to create default charm:", error);
    }
  }

  override render() {
    const spaceName = this.cc ? this.cc.manager().getSpaceName() : undefined;
    const charmList = this._charmList.value;

    if (!spaceName || !charmList) {
      return html`
        <x-spinner></x-spinner>
      `;
    }

    const list = (charmList ?? []).map((charm) => {
      const name = charm.name();
      const id = charm.id;
      const href = getNavigationHref(spaceName, id);
      return html`
        <li><a href="${href}">${name}</a></li>
      `;
    });
    return html`
      <h3>${spaceName}</h3>
      <ul>${list}</ul>
    `;
  }
}

globalThis.customElements.define("x-charm-list", XCharmListElement);
