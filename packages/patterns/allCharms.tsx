/// <cts-enable />
import {
  h,
  derive,
  NAME,
  recipe,
  str,
  UI,
  handler,
  navigateTo,
  Default,
} from "commontools";

type CharmListInput = {
  allCharms: Default<any[], []>;
};

type CharmListOutput = {
  ignore: boolean;
};

const visit = handler<{}, { charm: any }>((_, state) => {
  return navigateTo(state.charm);
});

// An example of how a recipe can reflect over charms in a space
// the `allCharms` input can be bound to the space-level list of charms
export default recipe<CharmListInput, CharmListOutput>(
  "Charm List",
  ({ allCharms }) => {
    const charmCount = derive(allCharms, (mentions) => mentions.length);

    return {
      [NAME]: str`Charms (${charmCount})`,
      ignore: true, // ignore ourselves when rendering recursively
      [UI]: (
        <div style="padding: 2rem; max-width: 600px;">
          <h2 id="charms-heading" >Charms ({charmCount})</h2>
          <div id="charms-grid">
            {/*NOTE: we should NOT need a derive wrapper around this BUT in practice, without one, items will sometimes render as undefined and never recover in a multi-user scenario.
              This is likely related to our known issues with shared arrays.
              This affects the tests, if you wanted to watch them, but also a real recipe. */}
            {derive(allCharms, (allCharms) =>
              allCharms.map((charm, index) => (
                <div id={`charm-card-${index}`}>
                  <div>
                    <span id={`charm-name-${index}`}>
                      {charm[NAME] || "Untitled Charm"}
                    </span>
                    <ct-button id={`visit-button-${index}`} size="sm" onClick={visit({ charm })}>
                      Visit
                    </ct-button>
                  </div>
                  {charm.ignore ? (
                    <></>
                  ) : (
                    <div>
                      {charm}
                    </div>
                  )}
                </div>
              )),
            )}
            {/* This SHOULD work but does not, with the behaviour explained above. */}
            {/* Specifically, this works on the first render but breaks thereafter */}
            {/*{
              allCharms.map((charm, index) => (
                <div id={str`charm-card-${index}`}>
                  <div>
                    <span id={str`charm-name-${index}`}>
                      {str`${charm[NAME] || "Untitled Charm"}`}
                    </span>
                    <ct-button id={str`visit-button-${index}`} size="sm" onClick={visit({ charm })}>
                      Visit
                    </ct-button>
                  </div>
                  {ifElse(
                    charm.ignore,
                    <></>,
                    <div>
                      {charm}
                    </div>
                  )}
                </div>
              ))
            }*/}
          </div>
        </div>
      ),
    };
  },
);
