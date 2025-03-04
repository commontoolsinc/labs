import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { getRecipe } from "@commontools/runner";
import { createPath } from "@/routes.ts";

export default function SpellbookLaunchView() {
  const { spellId } = useParams<{ spellId: string }>();
  const navigate = useNavigate();
  const { charmManager, currentReplica } = useCharmManager();

  useEffect(() => {
    const launchSpell = async () => {
      if (!spellId || !currentReplica) return;

      try {
        // Sync the recipe
        await charmManager.syncRecipeBlobby(spellId);
        const recipe = getRecipe(spellId);

        if (!recipe) {
          console.error("Recipe not found");
          navigate(createPath("spellbookDetail", { spellId }));
          return;
        }

        // Get AI suggestions for initial data
        const imagineUrl = `/api/ai/spell/imagine`;
        const response = await fetch(imagineUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            accepts: "application/json",
          },
          body: JSON.stringify({
            schema: recipe.argumentSchema?.properties,
            prompt: "", // TODO(bf): we can pass something to make this more personal
            options: {
              many: false,
            },
          }),
        });

        let initialData = {};
        if (response.ok) {
          const compatibleData = await response.json();
          initialData = compatibleData.result;
          console.log("AI response:", compatibleData);
        } else {
          console.error(
            `Failed to get AI suggestions: ${response.status} ${response.statusText}`,
          );
          throw new Error(
            `Failed to get AI suggestions: ${response.status} ${response.statusText}`,
          );
        }

        // Run the recipe with the initial data
        const charm = await charmManager.runPersistent(recipe, initialData);
        const charmIdString = charm?.entityId?.["/"] as string;
        await charmManager.add([charm]);

        if (charmIdString) {
          navigate(
            createPath("charmShow", {
              charmId: charmIdString,
              replicaName: currentReplica,
            }),
          );
        } else {
          console.error("Failed to create charm");
          navigate(createPath("spellbookDetail", { spellId }));
        }
      } catch (error) {
        console.error("Error launching spell:", error);
        navigate(createPath("spellbookDetail", { spellId }));
      }
    };

    launchSpell();
  }, [spellId, navigate, charmManager, currentReplica]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-4">Launching Spell...</h1>
        <p className="text-gray-600">
          Please wait while we prepare your spell.
        </p>
      </div>
    </div>
  );
}
