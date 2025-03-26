import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./commands.css";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useMatch, useNavigate } from "react-router-dom";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { DitheredCube } from "./DitherCube.tsx";
import {
  ActionCommandItem,
  CommandContext,
  CommandItem,
  CommandMode,
  ConfirmCommandItem,
  getCommands,
  InputCommandItem,
  MenuCommandItem,
  SelectCommandItem,
  TranscribeCommandItem,
} from "./commands.ts";
import { usePreferredLanguageModel } from "@/contexts/LanguageModelContext.tsx";
import { TranscribeInput } from "./TranscribeCommand.tsx";
import { useBackgroundTasks } from "@/contexts/BackgroundTaskContext.tsx";
import { Composer, ComposerSubmitBar } from "@/components/Composer.tsx";
import { charmId } from "@/utils/charms.ts";
import { formatPromptWithMentions } from "@/utils/format.ts";
import { NAME } from "@commontools/builder";
import {
  SpecPreviewModel,
  useLiveSpecPreview,
} from "@/hooks/use-live-spec-preview.ts";
import { SpecPreview } from "@/components/SpecPreview.tsx";

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
  const { charmManager } = context;
  const [inputValue, setInputValue] = useState("");
  const charmMentions = useCharmMentions();

  if (context.loading && mode.type !== "input") {
    return (
      <Command.Group>
        <div className="flex items-center justify-center p-4">
          <span className="text-sm text-gray-500">Processing...</span>
        </div>
      </Command.Group>
    );
  }

  const onSubmit = useCallback(async () => {
    if (mode.type !== "input") {
      return;
    }
    const { text, sources } = await formatPromptWithMentions(
      inputValue,
      charmManager,
    );
    if ((mode.command as InputCommandItem).handler) {
      (mode.command as InputCommandItem).handler(text, sources);
    }
  }, [mode, inputValue, charmManager]);

  switch (mode.type) {
    case "input": {
      // State for preview model selection
      const [previewModel, setPreviewModel] = useState<SpecPreviewModel>(
        "fast",
      );

      // Get spec preview as user types in command center
      const { previewSpec, previewPlan, loading: isPreviewLoading } =
        useLiveSpecPreview(
          inputValue,
          true,
          1000,
          previewModel,
        );

      return (
        <Command.Group>
          <div className="flex flex-col gap-2 mb-4">
            <div className="relative">
              {/* The floating spec preview will be positioned above the composer */}
              <SpecPreview
                spec={previewSpec}
                plan={previewPlan}
                loading={isPreviewLoading}
                visible
                floating
              />

              <Composer
                style={{
                  width: "100%",
                  height: "96px",
                  border: "1px solid #ccc",
                }}
                placeholder={mode.placeholder || "Enter input"}
                value={inputValue}
                onValueChange={setInputValue}
                mentions={charmMentions}
                onSubmit={onSubmit}
                disabled={context.loading}
                autoFocus
              />
            </div>

            <ComposerSubmitBar
              loading={context.loading}
              operation="Send"
              onSubmit={onSubmit}
            >
              <div className="flex items-center space-x-2">
                <div className="flex items-center text-xs">
                  <div className="flex border border-gray-300 rounded-full overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setPreviewModel("fast")}
                      className={`px-2 py-1 text-xs ${
                        previewModel === "fast"
                          ? "bg-black text-white"
                          : "bg-gray-100"
                      }`}
                    >
                      Fast
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewModel("think")}
                      className={`px-2 py-1 text-xs ${
                        previewModel === "think"
                          ? "bg-black text-white"
                          : "bg-gray-100"
                      }`}
                    >
                      Smart
                    </button>
                  </div>
                </div>
              </div>
            </ComposerSubmitBar>
          </div>
        </Command.Group>
      );
    }

    case "confirm": {
      return (
        <Command.Group heading="Confirm">
          <Command.Item
            value="yes"
            onSelect={() => {
              if ((mode.command as ConfirmCommandItem).handler) {
                (mode.command as ConfirmCommandItem).handler(context);
              }
            }}
          >
            Yes
          </Command.Item>
          <Command.Item value="no" onSelect={onComplete}>
            No
          </Command.Item>
        </Command.Group>
      );
    }

    case "transcribe": {
      return (
        <Command.Group>
          <TranscribeInput mode={mode} context={context} />
        </Command.Group>
      );
    }

    case "select": {
      return (
        <>
          {mode.options.map((option) => (
            <Command.Item
              key={option.id}
              onSelect={() => {
                if ((mode.command as SelectCommandItem).handler) {
                  (mode.command as SelectCommandItem).handler(option.value);
                }
              }}
            >
              {option.title}
            </Command.Item>
          ))}
        </>
      );
    }

    default:
      return null;
  }
}

export function useCharmMentions() {
  const { charmManager } = useCharmManager();
  const [charmMentions, setCharmMentions] = useState<
    Array<{ id: string; name: string }>
  >([]);

  // Fetch charms for mentions when the component mounts
  useEffect(() => {
    const fetchCharmMentions = async () => {
      try {
        const charms = charmManager.getCharms();
        await charmManager.sync(charms);

        const mentions = charms.get().map((charm: any) => {
          const data = charm.get();
          const name = data?.[NAME] ?? "Untitled";
          const id = charmId(charm.entityId!)!;
          return {
            id,
            name: `${name} (#${id.slice(-4)})`,
          };
        });

        setCharmMentions(mentions);
      } catch (error) {
        console.error("Error fetching charm mentions:", error);
      }
    };

    fetchCharmMentions();
  }, [charmManager]);

  return charmMentions;
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
  const replicaMatch = useMatch("/:replicaName/:charmId?/*");
  const stackMatch = useMatch("/:replicaName/stack/:charmIds/*");
  const focusedCharmId = stackMatch?.params.charmIds ??
    replicaMatch?.params.charmId ?? null;
  const focusedReplicaId = stackMatch?.params.replicaName ??
    replicaMatch?.params.replicaName ?? null;

  const charmMentions = useCharmMentions();

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
          if ((cmd as MenuCommandItem).children) {
            const found = findInCommands((cmd as MenuCommandItem).children!);
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
      : ((getCommandById(
        commandPathIds[commandPathIds.length - 1],
      ) as MenuCommandItem)?.children ??
        []);

    return commands.filter((cmd: CommandItem) => cmd.predicate !== false); // Show command unless predicate is explicitly false
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

      {/* Only show the standard input field when not in input or transcribe mode */}
      {mode.type !== "input" && mode.type !== "transcribe" && (
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
            placeholder={mode.type === "confirm"
              ? mode.message || "Are you sure?"
              : "What would you like to do?"}
            readOnly={mode.type === "confirm"}
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              // For select mode, prevent the default Enter behavior
              if (mode.type === "select" && e.key === "Enter") {
                e.preventDefault();
              }
            }}
            style={{ flexGrow: 1 }}
          />
        </div>
      )}

      <Command.List>
        {!loading && mode.type != "input" && mode.type != "transcribe" && (
          <Command.Empty>No results found.</Command.Empty>
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
                    (acc: Record<string, CommandItem[]>, cmd: CommandItem) => {
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
                          if ((cmd as MenuCommandItem).children) {
                            setCommandPathIds((
                              prev: string[],
                            ) => [...prev, cmd.id]);
                            setMode({
                              type: "menu",
                              path: [...commandPathIds, cmd.id],
                              parent: cmd,
                            });
                          } else if (cmd.type === "action") {
                            // Only close if the handler doesn't return a Promise
                            // This allows async handlers that change mode to keep the palette open
                            const actionCmd = cmd as ActionCommandItem;
                            const result = actionCmd.handler?.();
                            if (
                              !actionCmd.handler ||
                              (!result &&
                                typeof actionCmd.handler === "function")
                            ) {
                              setOpen(false);
                            }
                          } else {
                            // Handle each command type explicitly
                            switch (cmd.type) {
                              case "input":
                                setMode({
                                  type: "input",
                                  command: cmd,
                                  placeholder:
                                    (cmd as InputCommandItem).placeholder ||
                                    "Enter input",
                                });
                                break;
                              case "confirm":
                                setMode({
                                  type: "confirm",
                                  command: cmd,
                                  message:
                                    (cmd as ConfirmCommandItem).message ||
                                    "Are you sure?",
                                });
                                break;
                              case "select":
                                setMode({
                                  type: "select",
                                  command: cmd,
                                  options: [], // You'll need to provide the actual options here
                                });
                                break;
                              case "transcribe":
                                setMode({
                                  type: "transcribe",
                                  command: cmd,
                                  placeholder: (cmd as TranscribeCommandItem)
                                    .placeholder ||
                                    "Speak now...",
                                });
                                break;
                              case "placeholder":
                                setMode({
                                  type: "placeholder",
                                });
                                break;
                              default:
                                console.warn(
                                  `Unhandled command type: ${cmd.type}`,
                                );
                                break;
                            }
                          }
                        }}
                      >
                        {cmd.title}
                        {(cmd as MenuCommandItem).children && " →"}
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
