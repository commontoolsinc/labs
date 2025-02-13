import { Command } from "cmdk";
import { useState, useEffect } from "react";
import "./commands.css";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useMatch, useNavigate } from "react-router-dom";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { DitheredCube } from "./DitherCube";
import { CommandContext, CommandItem, CommandMode, commands } from "./commands";

function CommandProcessor({
  mode,
  command,
  context,
  onComplete,
}: {
  mode: CommandMode;
  command: CommandItem;
  context: CommandContext;
  onComplete: () => void;
}) {
  if (context.loading) {
    return (
      <Command.Group>
        <div className="flex items-center justify-center p-4">
          <span className="text-sm text-gray-500">Processing...</span>
        </div>
      </Command.Group>
    );
  }

  switch (mode.type) {
    case "input":
      return <></>;

    case "confirm":
      return (
        <>
          <div>{mode.message}</div>
          <Command.Item onSelect={() => command.handler?.(context)}>Yes</Command.Item>
          <Command.Item onSelect={onComplete}>No</Command.Item>
        </>
      );

    case "select":
      return (
        <>
          {mode.options.map((option) => (
            <Command.Item
              key={option.id}
              onSelect={() => mode.command.handler?.(context, option.value)} // Use mode.command instead
            >
              {option.title}
            </Command.Item>
          ))}
        </>
      );

    default:
      return null;
  }
}

export function CommandCenter() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CommandMode>({ type: "main" });
  const [commandPath, setCommandPath] = useState<CommandItem[]>([]);
  const [search, setSearch] = useState("");

  const { charmManager } = useCharmManager();
  const navigate = useNavigate();
  const match = useMatch("/:replicaName/:charmId?/*");
  const focusedCharmId = match?.params.charmId ?? null;
  const focusedReplicaId = match?.params.replicaName ?? null;

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
    setSearch("");
  }, [mode]);

  useEffect(() => {
    if (!open) {
      setMode({ type: "main" });
      setCommandPath([]);
    }
  }, [open]);

  useEffect(() => {
    const handleEditRecipe = (e: KeyboardEvent) => {
      if (e.key === "i" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        setMode({
          type: "input",
          command: commands.find((cmd) => cmd.id === "edit-recipe")!,
          placeholder: "Enter new recipe",
        });
      }
    };

    const handleEditRecipeEvent = () => {
      if (focusedCharmId) {
        // Only open if there's a charm focused
        setOpen(true);
        setMode({
          type: "input",
          command: commands.find((cmd) => cmd.id === "edit-recipe")!,
          placeholder: "What would you like to change?",
        });
      }
    };

    document.addEventListener("keydown", handleEditRecipe);
    window.addEventListener("edit-recipe-command", handleEditRecipeEvent);

    return () => {
      document.removeEventListener("keydown", handleEditRecipe);
      window.removeEventListener("edit-recipe-command", handleEditRecipeEvent);
    };
  }, [focusedCharmId]); // Add focusedCharmId as a dependency

  const context: CommandContext = {
    charmManager,
    navigate,
    focusedCharmId,
    focusedReplicaId,
    setOpen,
    setMode,
    loading,
    setLoading,
  };

  const handleBack = () => {
    if (commandPath.length === 1) {
      setMode({ type: "main" });
      setCommandPath([]);
    } else {
      setCommandPath((prev) => prev.slice(0, -1));
      setMode({
        type: "menu",
        path: commandPath.slice(0, -1),
        parent: commandPath[commandPath.length - 2],
      });
    }
  };

  const getCurrentCommands = () => {
    const currentCommands =
      commandPath.length === 0 ? commands : commandPath[commandPath.length - 1].children || [];

    return currentCommands.filter((cmd) => !cmd.predicate || cmd.predicate(context));
  };
  return (
    <Command.Dialog title="Common" open={open} onOpenChange={setOpen} label="Command Menu">
      <VisuallyHidden>
        <>
          <DialogTitle>Common</DialogTitle>
          <DialogDescription>Common commands for managing charms.</DialogDescription>
        </>
      </VisuallyHidden>

      <div className="flex items-center gap-2">
        <div className="w-10 h-10 flex-shrink-0">
          <DitheredCube
            animationSpeed={loading ? 2 : 1}
            width={40}
            height={40}
            animate={loading}
            cameraZoom={loading ? 12 : 14}
          />
        </div>
        <Command.Input
          placeholder={mode.type === "input" ? mode.placeholder : "What would you like to do?"}
          value={search}
          onValueChange={setSearch}
          onKeyDown={(e) => {
            if (mode.type === "input" && e.key === "Enter") {
              e.preventDefault();
              const command = mode.command;
              command.handler?.(context, search);
            }
          }}
          style={{ flexGrow: 1 }}
        />
      </div>

      <Command.List>
        {!loading && mode.type != "input" && <Command.Empty>No results found.</Command.Empty>}
        {loading && (
          <Command.Loading>
            <div className="flex items-center justify-center p-4">
              <span className="text-sm text-gray-500">Processing...</span>
            </div>
          </Command.Loading>
        )}

        {mode.type === "main" || mode.type === "menu" ? (
          <>
            {commandPath.length > 0 && (
              <Command.Item onSelect={handleBack}>
                ← Back to {commandPath[commandPath.length - 2]?.title || "Main Menu"}
              </Command.Item>
            )}

            {(() => {
              const groups = getCurrentCommands().reduce(
                (acc, cmd) => {
                  const group = cmd.group || "Other";
                  if (!acc[group]) acc[group] = [];
                  acc[group].push(cmd);
                  return acc;
                },
                {} as Record<string, CommandItem[]>,
              );

              return Object.entries(groups).map(([groupName, commands]) => (
                <Command.Group key={groupName} heading={groupName}>
                  {commands.map((cmd) => (
                    <Command.Item
                      key={cmd.id}
                      onSelect={() => {
                        if (cmd.children) {
                          setCommandPath((prev) => [...prev, cmd]);
                          setMode({
                            type: "menu",
                            path: [...commandPath, cmd],
                            parent: cmd,
                          });
                        } else if (cmd.type === "action") {
                          cmd.handler?.(context);
                          // Only close if the handler doesn't set a new mode
                          if (!cmd.handler || cmd.handler.length === 0) {
                            setOpen(false);
                          }
                        } else {
                          setMode({ type: cmd.type, command: cmd });
                        }
                      }}
                    >
                      {cmd.title}
                      {cmd.children && " →"}
                    </Command.Item>
                  ))}
                </Command.Group>
              ));
            })()}
          </>
        ) : (
          <CommandProcessor
            mode={mode}
            command={commandPath[commandPath.length - 1]}
            context={context}
            onComplete={() => {
              setMode({
                type: "menu",
                path: commandPath,
                parent: commandPath[commandPath.length - 1],
              });
            }}
          />
        )}
      </Command.List>
    </Command.Dialog>
  );
}
