import { Command } from "cmdk";
import { useState, useEffect, useRef } from "react";
import "./commands.css";
import { castNewRecipe, iterate } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useMatch, useNavigate } from "react-router-dom";
import { castSpell } from "@/search";
import { charmId } from "@/utils/charms";
import { Dialog, VisuallyHidden } from "radix-ui";

export function CommandCenter() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const importRef = useRef<HTMLInputElement>();
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();

  const match = useMatch("/:replicaName/:charmId?");
  const focusedCharmId = match?.params.charmId ?? null;
  const focusedReplicaId = match?.params.replicaName ?? null;

  // Handle keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Command handlers
  const handleNewCharm = async () => {
    const dummyData = {
      gallery: [{ title: "pizza", prompt: "a yummy pizza" }],
    };

    const title = prompt("Enter a title for your new charm:");
    if (!title) return;

    const id = await castNewRecipe(charmManager, { gallery: [dummyData] }, title);
    if (id) {
      navigate(`/${focusedReplicaId}/${id}`);
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
            navigate(`/${focusedReplicaId}/${id}`);
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

  // Cleanup file input on unmount
  useEffect(() => {
    return () => {
      if (importRef.current) {
        document.body.removeChild(importRef.current);
      }
    };
  }, []);

  const handleSearchCharms = async (query: string) => {
    setLoading(true);
    // Implement async charm search
    console.log("Searching charms:", query);
    setLoading(false);
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

      console.log("Casting spell", spellInput);
      const spells = await castSpell(focusedReplicaId, spellInput);
      // setSearchResults(spells); // Make sure to handle the results
      console.log("Spell results:", spells);
    } catch (error) {
      console.error("Spellcaster error:", error);
      alert("Failed to cast spell");
    } finally {
      setLoading(false);
      setOpen(false);
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
      <VisuallyHidden.VisuallyHidden>
        <>
          <Dialog.Title>Common</Dialog.Title>
          <Dialog.Description>Common commands for managing charms.</Dialog.Description>
        </>
      </VisuallyHidden.VisuallyHidden>

      <Command.Input
        placeholder="What would you like to do?"
        value={search}
        onValueChange={setSearch}
      />
      <Command.List>
        <Command.Empty>No results found.</Command.Empty>

        {loading && <Command.Loading>Loading...</Command.Loading>}

        <Command.Group heading="Actions">
          <Command.Item onSelect={handleNewCharm}>New Charm</Command.Item>
          <Command.Item onSelect={() => handleSearchCharms(search)}>Search Charms</Command.Item>
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
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
