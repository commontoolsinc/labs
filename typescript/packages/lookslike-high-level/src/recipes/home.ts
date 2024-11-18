import { html } from "@commontools/common-html";
import { recipe, lift, NAME, UI, handler } from "@commontools/common-builder";
import { getEntityId } from "@commontools/common-runner";
import { Charm, removeCharm, RecipeManifest, closeCharm } from "../data.js";

const getCharmsWithNameAndUI = lift<Charm[], { charm: Charm }[]>((charms) =>
  (charms ?? [])
    .filter((charm) => charm && charm[UI] && charm[NAME])
    .map((charm) => ({ charm })),
);

const deleteCharm = handler<{}, { charm: Charm }>((_, { charm }) => {
  const charmId = getEntityId(charm)!;
  console.log("deleteCharm", charmId);
  removeCharm(charmId);
  closeCharm(charmId);
});

export const home = recipe<{
  charms: Charm[];
  recipes: RecipeManifest[];
}>("Home Screen", ({ charms, recipes }) => {
  return {
    [NAME]: "Home",
    [UI]: html`<common-vstack
      >${getCharmsWithNameAndUI(charms).map(
        ({ charm }) =>
          html`<div>
            <common-droppable
              $droppable=${charm["action/drop/handler"]}
              $schema=${charm["action/drop/schema"]}
              $opentarget=${charm}
            >
              <common-charm-link $charm=${charm}></common-charm-link>
              <button onclick=${deleteCharm({ charm })}>×</button>
            </common-droppable>
          </div>`,
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link recipe=${recipe.recipeId}>
              👨‍🍳 ${recipe.name}</common-recipe-link
            >
          </div>`,
      )}
      <common-annotation-toggle />
      <common-annotation
        query="dream fun things to explore"
        target="-1"
        data=${{ charms, recipes }}
      />
    </common-vstack>`,
  };
});
