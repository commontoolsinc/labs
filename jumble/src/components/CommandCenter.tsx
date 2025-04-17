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
import { WorkflowForm } from "@commontools/charm";
import { TranscribeInput } from "./TranscribeCommand.tsx";
import { Composer, ComposerSubmitBar } from "@/components/Composer.tsx";
import { charmId, getMentionableCharms } from "@/utils/charms.ts";
import { NAME } from "@commontools/builder";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { useLiveSpecPreview } from "@/hooks/use-live-spec-preview.ts";
import { SpecPreview } from "@/components/SpecPreview.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import {
  LanguageModelId as LanguageModelId,
  ModelSelector,
  useUserPreferredModel,
} from "@/components/common/ModelSelector.tsx";

function CommandProcessor({
  mode,
  command,
  context,
  onComplete,
  onPreviewUpdated,
}: {
  mode: CommandMode;
  command: CommandItem;
  context: CommandContext;
  onComplete: () => void;
  onPreviewUpdated: (model: Partial<WorkflowForm>) => void;
}) {
  const { charmManager } = context;
  const [inputValue, setInputValue] = useState("");
  const charmMentions = useCharmMentions();

  // State for preview model selection
  // const [previewModel, setPreviewModel] = useState<LanguageModelId>(
  //   "think",
  // );

  const {
    userPreferredModel,
    setUserPreferredModel,
  } = useUserPreferredModel();

  // Get the focused charm if available
  const { focusedCharmId } = context;
  const [focusedCharm, setFocusedCharm] = useState<Cell<Charm> | undefined>(
    undefined,
  );

  // Fetch the focused charm when ID changes
  useEffect(() => {
    if (focusedCharmId) {
      charmManager.get(focusedCharmId, false).then((charm) => {
        if (charm) {
          setFocusedCharm(charm);
        }
      }).catch((err) => {
        console.error("Error fetching focused charm:", err);
      });
    } else {
      setFocusedCharm(undefined);
    }
  }, [focusedCharmId, charmManager]);

  // Get spec preview as user types in command center
  const {
    previewForm,
    loading: isPreviewLoading,
    classificationLoading,
    planLoading,
    setWorkflowType, // Add the setter function to allow changing workflow type manually
  } = useLiveSpecPreview(
    inputValue,
    charmManager, // Explicitly pass CharmManager instance
    true,
    1000,
    userPreferredModel,
    command.id == "new-charm" ? undefined : focusedCharm, // Pass the current charm for context
  );

  useEffect(() => {
    if (previewForm) {
      console.log("Preview form updated:", previewForm);
      onPreviewUpdated(previewForm);
      context.previewForm = previewForm;
    }
  }, [previewForm, onPreviewUpdated]);

  if (context.loading && mode.type !== "input") {
    return (
      <Command.Group>
        <div className="flex items-center justify-center p-4">
          <span className="text-sm text-gray-500">Processing...</span>
        </div>
      </Command.Group>
    );
  }

  const onSubmit = useCallback(() => {
    if (mode.type !== "input") {
      return;
    }
    if ((mode.command as InputCommandItem).handler) {
      (mode.command as InputCommandItem).handler(context, inputValue);
      // Close the command center after submitting
      context.setOpen(false);
    }
  }, [
    context,
    mode,
    inputValue,
    charmManager,
    previewForm,
  ]);

  switch (mode.type) {
    case "input": {
      return (
        <div className="flex flex-col gap-2 mb-4">
          <div className="relative">
            {/* The floating spec preview will be positioned above the composer */}
            <SpecPreview
              form={previewForm}
              loading={isPreviewLoading}
              classificationLoading={classificationLoading}
              planLoading={planLoading}
              visible
              floating
              onWorkflowChange={setWorkflowType}
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
                <ModelSelector
                  value={userPreferredModel ?? ""}
                  onChange={(value) => setUserPreferredModel(value)}
                  size="small"
                  mapPreview
                />
              </div>
            </div>
          </ComposerSubmitBar>
        </div>
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
        // Get mentionable charms - filtered to exclude trash and prioritize pinned
        const mentionableCharms = await getMentionableCharms(charmManager);

        // Convert to the format needed for mentions
        const mentions = mentionableCharms.map((charm) => {
          const data = charm.get();
          const name = data?.[NAME] ?? "Untitled";
          const id = charmId(charm);
          if (!id) {
            console.warn(`Warning: Charm without ID found`, charm);
            return null;
          }
          return {
            id,
            name: `${name} (#${id.slice(-4)})`,
          };
        }).filter((mention): mention is { id: string; name: string } =>
          mention !== null
        );

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
  const { clearAuthentication } = useAuthentication();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CommandMode>({ type: "main" });
  const [commandPathIds, setCommandPathIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const { charmManager } = useCharmManager();
  const navigate = useNavigate();
  // TODO(bf): matchesRoute?
  const replicaMatch = useMatch("/:replicaName/:charmId?/*");
  const stackMatch = useMatch("/:replicaName/stack/:charmIds/*");
  const focusedCharmId = stackMatch?.params.charmIds ??
    replicaMatch?.params.charmId ?? null;
  const focusedReplicaId = stackMatch?.params.replicaName ??
    replicaMatch?.params.replicaName ?? null;

  const [previewForm, setPreviewForm] = useState<Partial<WorkflowForm>>();
  const { userPreferredModel } = useUserPreferredModel();

  // TODO(bf): this is duplicated from the use in allCommands
  const context = useMemo<CommandContext>(() => ({
    charmManager,
    userPreferredModel,
    navigate,
    focusedCharmId,
    focusedReplicaId,
    setOpen,
    setMode,
    loading,
    setLoading,
    setModeWithInput: (mode: CommandMode, initialInput: string) => {
      Promise.resolve().then(() => {
        setMode(mode);
        setSearch(initialInput);
      });
    },
    commandPathIds,
    onClearAuthentication: clearAuthentication,
    previewForm,
  }), [
    charmManager,
    navigate,
    focusedCharmId,
    focusedReplicaId,
    setOpen,
    setMode,
    loading,
    setLoading,
    commandPathIds,
    clearAuthentication,
    previewForm,
  ]);

  const allCommands = useMemo(
    () => getCommands(context),
    [context],
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
        const editRecipeCommand = allCommands.find((cmd) =>
          cmd.id === "edit-recipe"
        );
        if (!editRecipeCommand) {
          console.warn("Edit recipe command not found");
          return;
        }
        setOpen(true);
        setMode({
          type: "input",
          command: editRecipeCommand,
          placeholder: "What would you like to change?",
        });
      }
    };

    const handleEditRecipeEvent = () => {
      if (focusedCharmId) {
        const editRecipeCommand = allCommands.find((cmd) =>
          cmd.id === "edit-recipe"
        );
        if (!editRecipeCommand) {
          console.warn("Edit recipe command not found");
          return;
        }
        setOpen(true);
        setMode({
          type: "input",
          command: editRecipeCommand,
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

  const handleCommandSelect = useCallback((cmd: CommandItem, e: any) => {
    console.log(
      `Command selected: ${cmd.id}, type: ${cmd.type}`,
      e,
    );

    if ((cmd as MenuCommandItem).children) {
      console.log(
        `Command has children - setting menu mode`,
      );
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
          {
            // Ensure all input commands have required properties
            const inputCommand = cmd as InputCommandItem;
            console.log(
              `Setting mode for input command: ${inputCommand.id}, placeholder: ${inputCommand.placeholder}`,
            );

            setMode({
              type: "input",
              command: inputCommand,
              placeholder: inputCommand.placeholder ||
                "Enter input",
            });
          }
          break;
        case "confirm":
          setMode({
            type: "confirm",
            command: cmd,
            message: (cmd as ConfirmCommandItem).message ||
              "Are you sure?",
          });
          break;
        case "select":
          // The select mode options should be provided by the command handler
          // since the SelectCommandItem interface doesn't have an options property
          setMode({
            type: "select",
            command: cmd,
            options: [], // Options will be provided when the command is executed
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
  }, [commandPathIds, setMode, setCommandPathIds, setOpen]);

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
                        onSelect={(e) => handleCommandSelect(cmd, e)}
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
              command={"command" in mode
                ? mode.command
                : currentCommandPath[currentCommandPath.length - 1]}
              context={context}
              onPreviewUpdated={setPreviewForm}
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
