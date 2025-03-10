import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./commands.css";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useMatch, useNavigate } from "react-router-dom";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { DitheredCube } from "./DitherCube.tsx";
import {
  CommandContext,
  CommandItem,
  CommandMode,
  getCommands,
} from "./commands.ts";
import { usePreferredLanguageModel } from "@/contexts/LanguageModelContext.tsx";
import { TranscribeInput } from "./TranscribeCommand.tsx";
import { useBackgroundTasks } from "@/contexts/BackgroundTaskContext.tsx";

function CommandProcessor({
  mode,
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
      return null;

    case "confirm":
      return (
        <Command.Group heading="Confirm">
          <Command.Item
            value="yes"
            onSelect={() => mode.command.handler?.(context)}
          >
            Yes
          </Command.Item>
          <Command.Item value="no" onSelect={onComplete}>
            No
          </Command.Item>
        </Command.Group>
      );

    case "transcribe":
      return (
        <Command.Group>
          <TranscribeInput mode={mode} context={context} />
        </Command.Group>
      );

    case "select":
      return (
        <>
          {mode.options.map((option) => (
            <Command.Item
              key={option.id}
              onSelect={() => mode.command.handler?.(option.value)}
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
  const [commandPathIds, setCommandPathIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const { modelId, setPreferredModel } = usePreferredLanguageModel();
  const { stopJob, startJob, addJobMessage, listJobs, updateJobProgress } =
    useBackgroundTasks();

  const { charmManager } = useCharmManager();
  const navigate = useNavigate();
  // TODO(bf): matchesRoute?
  const match = useMatch("/:replicaName/:charmId?/*");
  const focusedCharmId = match?.params.charmId ?? null;
  const focusedReplicaId = match?.params.replicaName ?? null;

  const allCommands = useMemo(
    () =>
      getCommands({
        charmManager,
        navigate,
        focusedCharmId,
        focusedReplicaId,
        setOpen,
        preferredModel: modelId ?? undefined,
        setPreferredModel,
        setMode,
        loading,
        setLoading,
        setModeWithInput: (mode: CommandMode, initialInput: string) => {
          Promise.resolve().then(() => {
            setMode(mode);
            setSearch(initialInput);
          });
        },
        stopJob,
        startJob,
        addJobMessage,
        listJobs,
        updateJobProgress,
        commandPathIds,
      }),
    [
      charmManager,
      navigate,
      focusedCharmId,
      focusedReplicaId,
      modelId,
      loading,
      commandPathIds,
      setMode,
      setPreferredModel,
      stopJob,
      startJob,
      addJobMessage,
      listJobs,
      updateJobProgress,
    ],
  );

  const getCommandById = useCallback(
    (id: string): CommandItem | undefined => {
      const findInCommands = (
        commands: CommandItem[],
      ): CommandItem | undefined => {
        for (const cmd of commands) {
          if (cmd.id === id) return cmd;
          if (cmd.children) {
            const found = findInCommands(cmd.children);
            if (found) return found;
          }
        }
        return undefined;
      };
      return findInCommands(allCommands);
    },
    [allCommands],
  );

  const currentCommandPath = useMemo(
    () =>
      commandPathIds.map((id) => getCommandById(id)).filter((
        cmd,
      ): cmd is CommandItem => !!cmd),
    [commandPathIds, getCommandById],
  );

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
    globalThis.addEventListener("open-command-center", handleOpenCommandCenter);

    return () => {
      document.removeEventListener("keydown", down);
      globalThis.removeEventListener(
        "open-command-center",
        handleOpenCommandCenter,
      );
    };
  }, []);

  useEffect(() => {
    if (!("preserveInput" in mode) || !mode.preserveInput) {
      setSearch("");
    }
  }, [mode]);

  useEffect(() => {
    if (!open) {
      setMode({ type: "main" });
      setCommandPathIds([]);
    }
  }, [open]);

  useEffect(() => {
    const handleEditRecipe = (e: KeyboardEvent) => {
      if (e.key === "i" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        setMode({
          type: "input",
          command: allCommands.find((cmd) => cmd.id === "edit-recipe")!,
          placeholder: "What would you like to change?",
        });
      }
    };

    const handleEditRecipeEvent = () => {
      if (focusedCharmId) {
        setOpen(true);
        setMode({
          type: "input",
          command: allCommands.find((cmd) => cmd.id === "edit-recipe")!,
          placeholder: "What would you like to change?",
        });
      }
    };

    document.addEventListener("keydown", handleEditRecipe);
    globalThis.addEventListener("edit-recipe-command", handleEditRecipeEvent);

    return () => {
      document.removeEventListener("keydown", handleEditRecipe);
      globalThis.removeEventListener(
        "edit-recipe-command",
        handleEditRecipeEvent,
      );
    };
  }, [focusedCharmId, allCommands]);

  const context: CommandContext = {
    charmManager,
    navigate,
    focusedCharmId,
    focusedReplicaId,
    setOpen,
    preferredModel: modelId ?? undefined,
    setPreferredModel,
    setMode,
    loading,
    setLoading,
    setModeWithInput: (mode: CommandMode, initialInput: string) => {
      Promise.resolve().then(() => {
        setMode(mode);
        setSearch(initialInput);
      });
    },
    stopJob,
    startJob,
    addJobMessage,
    listJobs,
    updateJobProgress,
    commandPathIds,
  };

  const handleBack = () => {
    if (commandPathIds.length === 1) {
      setMode({ type: "main" });
      setCommandPathIds([]);
    } else {
      setCommandPathIds((prev) => prev.slice(0, -1));
      const parentId = commandPathIds[commandPathIds.length - 2];
      const parentCommand = getCommandById(parentId);
      if (parentCommand) {
        setMode({
          type: "menu",
          path: commandPathIds.slice(0, -1),
          parent: parentCommand,
        });
      }
    }
  };

  const getCurrentCommands = () => {
    const commands = commandPathIds.length === 0
      ? allCommands
      : getCommandById(commandPathIds[commandPathIds.length - 1])?.children ??
        [];

    return commands.filter((cmd) => cmd.predicate !== false); // Show command unless predicate is explicitly false
  };

  return (
    <Command.Dialog
      title="Common"
      open={open}
      onOpenChange={setOpen}
      label="Command Menu"
    >
      <VisuallyHidden>
        <DialogTitle>Common</DialogTitle>
        <DialogDescription>
          Common commands for managing charms.
        </DialogDescription>
      </VisuallyHidden>

      <div
        className="flex items-center gap-2"
        style={{ display: mode.type == "transcribe" ? "none" : "flex" }}
      >
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
          placeholder={mode.type === "confirm"
            ? mode.message || "Are you sure?"
            : mode.type === "input"
            ? mode.placeholder
            : "What would you like to do?"}
          readOnly={mode.type === "confirm"}
          value={search}
          onValueChange={setSearch}
          onKeyDown={(e) => {
            // Only handle Enter for input mode, ignore for select mode
            if (mode.type === "input" && e.key === "Enter") {
              e.preventDefault();
              const command = mode.command;
              command.handler?.(search);
            }
            // For select mode, prevent the default Enter behavior
            if (mode.type === "select" && e.key === "Enter") {
              e.preventDefault();
            }
          }}
          style={{ flexGrow: 1 }}
        />
      </div>

      <Command.List>
        {!loading && mode.type != "input" && mode.type != "transcribe" && (
          <Command.Empty>No results found.</Command.Empty>
        )}
        {loading && (
          <Command.Loading>
            <div className="flex items-center justify-center p-4">
              <span className="text-sm text-gray-500">Processing...</span>
            </div>
          </Command.Loading>
        )}

        {mode.type === "main" || mode.type === "menu"
          ? (
            <>
              {commandPathIds.length > 0 && (
                <Command.Item onSelect={handleBack}>
                  ← Back to{" "}
                  {getCommandById(commandPathIds[commandPathIds.length - 2])
                    ?.title || "Main Menu"}
                </Command.Item>
              )}

              {(() => {
                const groups: Record<string, CommandItem[]> =
                  getCurrentCommands().reduce(
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
                            setCommandPathIds((prev) => [...prev, cmd.id]);
                            setMode({
                              type: "menu",
                              path: [...commandPathIds, cmd.id],
                              parent: cmd,
                            });
                          } else if (cmd.type === "action") {
                            // Only close if the handler doesn't return a Promise
                            // This allows async handlers that change mode to keep the palette open
                            const result = cmd.handler?.(context);
                            if (
                              !cmd.handler ||
                              (!result && cmd.handler.length === 0)
                            ) {
                              setOpen(false);
                            }
                          } else {
                            // TODO(bf): need to refactor types
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
          )
          : (
            <CommandProcessor
              mode={mode}
              command={currentCommandPath[currentCommandPath.length - 1]}
              context={context}
              onComplete={() => {
                setMode({
                  type: "menu",
                  path: commandPathIds,
                  parent: currentCommandPath[currentCommandPath.length - 1],
                });
              }}
            />
          )}
      </Command.List>
    </Command.Dialog>
  );
}
