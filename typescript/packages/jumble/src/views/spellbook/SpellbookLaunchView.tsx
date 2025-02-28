import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useSpaceManager } from "@/contexts/SpaceManagerContext";
import { getRecipe } from "@commontools/runner";
import { createPath } from "@/routes.ts";

export default function SpellbookLaunchView() {
  const { spellId } = useParams<{ spellId: string }>();
  const navigate = useNavigate();
  const { spaceManager, currentSpaceURI: currentReplica } = useSpaceManager();

  useEffect(() => {
    const launchSpell = async () => {
      if (!spellId || !currentReplica) return;

      try {
        // Sync the recipe
        await spaceManager.syncRecipeBlobby(spellId);
        const recipe = getRecipe(spellId);

        if (!recipe) {
          console.error("Recipe not found");
          navigate(createPath('spellbookDetail', { spellId }));
          return;
        }

        // Get AI suggestions for initial data
        const fulfillUrl = `/api/ai/spell/fulfill`;
        const response = await fetch(fulfillUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            accepts: "application/json",
          },
          body: JSON.stringify({
            schema: recipe.argumentSchema?.properties,
            many: false,
            prompt: "",
            options: {
              format: "json",
              validate: true,
              maxExamples: 25,
            },
          }),
        });

        let initialData = {};
        if (response.ok) {
          const spellCasterFulfillResponse = await response.json();
          // TODO(jake): If there's no good initialData from spellcaster above,
          // what happens? Can/should we generate fake json data to fill the charm?
          initialData = spellCasterFulfillResponse.result;
          console.log("AI response:", spellCasterFulfillResponse);
        }

        // Run the recipe with the initial data
        const charm = await spaceManager.runPersistent(recipe, initialData);
        const charmIdString = charm.entityId?.toJSON?.()["/"];
        await spaceManager.add([charm]);

        if (charmIdString) {
          navigate(createPath('charmShow', { charmId: charmIdString, replicaName: currentReplica }));
        } else {
          console.error("Failed to create charm");
          navigate(createPath('spellbookDetail', { spellId }));
        }
      } catch (error) {
        console.error("Error launching spell:", error);
        navigate(createPath('spellbookDetail', { spellId }));
      }
    };

    launchSpell();
  }, [spellId, navigate, spaceManager, currentReplica]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-4">Launching Spell...</h1>
        <p className="text-gray-600">Please wait while we prepare your spell.</p>
      </div>
    </div>
  );
}
