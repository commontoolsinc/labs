import { Command } from "cmdk";
import { useState, useEffect, useRef } from "react";
import "./commands.css";
import { castNewRecipe, Charm, CharmManager, iterate, tsToExports } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useMatch, useNavigate } from "react-router-dom";
import { castSpell } from "@/search";
import { charmId } from "@/utils/charms";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Dialog, DialogDescription, DialogTitle } from "@radix-ui/react-dialog";

import { NAME } from "@commontools/builder";
import { DocImpl, getRecipe, addRecipe } from "@commontools/runner";

export function CommandCenter() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const importRef = useRef<HTMLInputElement>();
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();

  // bf: this will need to become a state machine eventualyl
  const [spellResults, setSpellResults] = useState<any[]>([]);
  const [charmResults, setCharmResults] = useState<any[]>([]);
  const [mode, setMode] = useState<"main" | "spellResults" | "charmResults" | "blobSelection">("main");
  const [selectedSpell, setSelectedSpell] = useState<any>(null);

  const match = useMatch("/:replicaName/:charmId?");
  const focusedCharmId = match?.params.charmId ?? null;
  const focusedReplicaId = match?.params.replicaName ?? null;

  // Handle keyboard shortcut and custom event
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    const handleOpenCommandCenter = () => {
      setOpen(true);
    };

    document.addEventListener("keydown", down);
    window.addEventListener("open-command-center", handleOpenCommandCenter);

    return () => {
      document.removeEventListener("keydown", down);
      window.removeEventListener("open-command-center", handleOpenCommandCenter);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setMode("main");
      setSpellResults([]);
      setCharmResults([]);
      setSelectedSpell(null); // Add this line
    }
  }, [open]);

  useEffect(() => {
    setSearch("");
  }, [mode]);

  async function castSpellAsCharm(charmManager: CharmManager, result: any, blob: any) {
    const recipeKey = result?.key;

    if (recipeKey && blob) {
      console.log("Syncing...");
      const recipeId = recipeKey.replace("spell-", "");
      await charmManager.syncRecipeBlobby(recipeId);

      const recipe = getRecipe(recipeId);
      if (!recipe) return;

      console.log("Casting...");
      const doc = await charmManager.sync({ "/": blob.key }, true);
      const charm: DocImpl<Charm> = await charmManager.runPersistent(recipe, {
        cell: doc,
        path: ["argument"],
      });
      charmManager.add([charm]);
      navigate(`/${focusedReplicaId}/${charmId(charm.entityId!)}`);
      console.log("Ready!");
    } else {
      console.log("Failed to cast");
    }
  }

  // Command handlers
  const handleNewCharm = async () => {
    const dummyData = {
      gallery: [{ title: "pizza", prompt: "a yummy pizza" }],
    };

    const title = prompt("Enter a title for your new charm:");
    if (!title) return;

    const id = await castNewRecipe(charmManager, { gallery: [dummyData] }, title);
    if (id) {
      navigate(`/${focusedReplicaId}/${charmId(id)}`);
    }
    setOpen(false);
  };

  const handleImportJSON = async () => {
    if (!importRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.style.display = "none";

      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const data = JSON.parse(text);

          const title = prompt("Enter a title for your imported recipe:");
          if (!title) return;

          const id = await castNewRecipe(charmManager, data, title);
          if (id) {
            navigate(`/${focusedReplicaId}/${charmId(id)}`);
          }
          setOpen(false);
        } catch (err) {
          console.error("Failed to import JSON:", err);
          alert("Failed to import JSON file. Please check the file format.");
        }
      };

      document.body.appendChild(input);
      importRef.current = input;
    }

    importRef.current.click();
  };

  const handleLoadRecipe = async () => {
    if (!importRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".tsx";
      input.style.display = "none";

      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const src = await file.text();
        const { exports, errors } = await tsToExports(src);
        if (errors) {
          console.error("Failed to compile TSX:", errors);
          setOpen(false);
          return;
        }
        let { default: recipe } = exports
        console.log("compiled", recipe)

        addRecipe(recipe, src, "imported", undefined);
        console.log("about to run charm")
        const newCharm = await charmManager.runPersistent(recipe, {});
        if (newCharm) {
          charmManager.add([newCharm]);
          navigate(`/${focusedReplicaId}/${charmId(newCharm.entityId!)}`);
        } else {
          console.error("failed to create a new charm")
        }

        setOpen(false);
      };

      document.body.appendChild(input);
      importRef.current = input;
    }

    importRef.current.click();
  };

  // Cleanup file input on unmount
  useEffect(() => {
    return () => {
      if (importRef.current) {
        document.body.removeChild(importRef.current);
      }
    };
  }, []);

  const handleSearchCharms = async () => {
    setLoading(true);
    try {
      const charms = charmManager.getCharms().get();

      const results = await Promise.all(
        charms.map(async (charm) => {
          const data = charm.cell.get();
          return {
            title: data[NAME] + ` (#${charmId(charm.cell.entityId!).slice(-4)})`,
            id: charmId(charm.cell.entityId!),
          };
        }),
      );

      setCharmResults(results);
      setMode("charmResults");
    } catch (error) {
      console.error("Search charms error:", error);
      alert("Failed to search charms");
    } finally {
      setLoading(false);
    }
  };

  const handleSpellcaster = async () => {
    setLoading(true);
    try {
      if (!focusedReplicaId) {
        console.error("No replica name found");
        return;
      }

      const spellInput = prompt("Enter your spell:");
      if (!spellInput) return;

      const spells = await castSpell(focusedReplicaId, spellInput);
      setSpellResults(spells);
      setMode("spellResults"); // Switch to results view
    } catch (error) {
      console.error("Spellcaster error:", error);
      alert("Failed to cast spell");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCharm = async () => {
    if (confirm("Are you sure you want to delete this charm?")) {
      if (!focusedCharmId) {
        console.error("Cannot delete charm: No charm ID focused");
        return;
      }
      console.log("Deleting charm", focusedCharmId);

      const charm = await charmManager.get(focusedCharmId);

      console.log(charm?.entityId);

      if (!charm || !charm.entityId) {
        console.error("Cannot delete charm: Failed to get charm data", { focusedCharmId });
        return;
      }

      const result = await charmManager.remove(charm?.entityId);
      console.log("Delete result:", result);

      if (result) {
        navigate("/");
      }
    } else {
      console.log("Cancelled charm deletion");
    }

    setOpen(false);
  };

  const handleEditRecipe = async () => {
    setLoading(true);
    try {
      if (!focusedCharmId) {
        console.error("No charm ID focused");
        return;
      }

      const charm = await charmManager.get(focusedCharmId);

      const newRecipe = prompt("Enter new recipe:");
      if (!newRecipe) return;

      const newCharmId = await iterate(charmManager, charm ?? null, newRecipe, false);
      if (newCharmId) {
        navigate(`/${focusedReplicaId}/${charmId(newCharmId)}`);
      }
    } catch (error) {
      console.error("Edit recipe error:", error);
      alert("Failed to edit recipe");
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  const handleNavigateBack = () => {
    window.history.back();
    setOpen(false);
  };

  const handleNavigateForward = () => {
    window.history.forward();
    setOpen(false);
  };

  const handleNavigateHome = () => {
    if (focusedReplicaId) {
      navigate(`/${focusedReplicaId}`);
    }
    setOpen(false);
  };

  const handleSwitchReplica = () => {
    const newReplica = prompt("Enter replica name:");
    if (newReplica) {
      navigate(`/${newReplica}`);
    }
    setOpen(false);
  };

  const handleToggleDetails = () => {
    if (!focusedCharmId) {
      console.error("Cannot toggle details: No charm focused");
      return;
    }
    window.dispatchEvent(new CustomEvent("toggle-details"));
    setOpen(false);
  };
  return (
    <Command.Dialog title="Common" open={open} onOpenChange={setOpen} label="Command Menu">
      <VisuallyHidden>
        <>
          <DialogTitle>Common</DialogTitle>
          <DialogDescription>Common commands for managing charms.</DialogDescription>
        </>
      </VisuallyHidden>

      <Command.Input
        placeholder={
          mode === "main"
            ? "What would you like to do?"
            : mode === "spellResults"
              ? "Search spell results..."
              : "Search charms..."
        }
        value={search}
        onValueChange={setSearch}
      />
      <Command.List>
        <Command.Empty>No results found.</Command.Empty>

        {loading && <Command.Loading>Loading...</Command.Loading>}

        {mode === "main" ? (
          <>
            <Command.Group heading="Actions">
              <Command.Item onSelect={handleNewCharm}>New Charm</Command.Item>
              <Command.Item onSelect={handleSearchCharms}>Search Charms</Command.Item>
              <Command.Item onSelect={handleSpellcaster}>Spellcaster</Command.Item>
            </Command.Group>

            <Command.Group heading="Edit">
              <Command.Item onSelect={() => console.log("Rename")}>Rename Charm</Command.Item>
              <Command.Item onSelect={handleDeleteCharm}>Delete Charm</Command.Item>
              <Command.Item onSelect={handleEditRecipe}>Edit Recipe</Command.Item>
            </Command.Group>

            <Command.Group heading="Navigation">
              <Command.Item onSelect={handleNavigateBack}>Navigate Back</Command.Item>
              <Command.Item onSelect={handleNavigateForward}>Navigate Forward</Command.Item>
              <Command.Item onSelect={handleNavigateHome}>Navigate Home</Command.Item>
            </Command.Group>

            <Command.Group heading="View">
              <Command.Item onSelect={handleSwitchReplica}>Switch Replica</Command.Item>
              {focusedCharmId && (
                <Command.Item onSelect={handleToggleDetails}>Toggle Details</Command.Item>
              )}
            </Command.Group>
            <Command.Group heading="Data">
              <Command.Item onSelect={handleImportJSON}>Import JSON</Command.Item>
              <Command.Item onSelect={handleLoadRecipe}>Load Recipe</Command.Item>
            </Command.Group>
          </>
        ) : mode === "spellResults" ? (
          <>
            <Command.Group heading="Spell Results">
              {spellResults
                .filter(result => result.compatibleBlobs && result.compatibleBlobs.length > 0)
                .map((result, index) => (
                  <Command.Item
                    key={index}
                    onSelect={async () => {
                      if (result.compatibleBlobs.length === 1) {
                        await castSpellAsCharm(charmManager, result, result.compatibleBlobs[0]);
                        setMode("main");
                        setOpen(false);
                      } else {
                        setSelectedSpell(result);
                        setMode("blobSelection");
                      }
                    }}
                  >
                    {`${result.description}#${result.name.slice(-4)} (${result.compatibleBlobs.length})`}
                  </Command.Item>
                ))}
            </Command.Group>
            {spellResults.filter(result => result.compatibleBlobs && result.compatibleBlobs.length > 0)
              .length === 0 && (
                <Command.Item onSelect={() => setMode("main")}>
                  No spells found with compatible blobs
                </Command.Item>
              )}
            <Command.Group>
              <Command.Item
                onSelect={() => {
                  setMode("main");
                  setSpellResults([]);
                }}
              >
                Back to Main Menu
              </Command.Item>
            </Command.Group>
          </>
        ) : mode === "blobSelection" ? (
          <>
            <Command.Group heading={`Select blob for ${selectedSpell?.name}`}>
              {selectedSpell?.compatibleBlobs.map((blob, index) => (
                <Command.Item
                  key={index}
                  onSelect={async () => {
                    await castSpellAsCharm(charmManager, selectedSpell, blob);
                    setMode("main");
                    setOpen(false);
                  }}
                >
                  {`Blob ${index + 1}`}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group>
              <Command.Item onSelect={() => setMode("spellResults")}>
                Back to Spell Results
              </Command.Item>
            </Command.Group>
          </>
        ) : (
          <>
            <Command.Group heading="Charm Results">
              {charmResults.map((charm, index) => (
                <Command.Item
                  key={charm.id}
                  onSelect={() => {
                    if (focusedReplicaId && charm.id) {
                      navigate(`/${focusedReplicaId}/${charm.id}`);
                      setMode("main");
                      setOpen(false);
                    }
                  }}
                >
                  {charm.title || `Charm ${index + 1}`}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group>
              <Command.Item
                onSelect={() => {
                  setMode("main");
                  setCharmResults([]);
                }}
              >
                Back to Main Menu
              </Command.Item>
            </Command.Group>
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
