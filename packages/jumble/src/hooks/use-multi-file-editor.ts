import { useCallback, useEffect, useState } from "react";
import {
  buildFullRecipe,
  Charm,
  charmId,
  compileRecipe,
  extractUserCode,
  generateNewRecipeVersion,
  getRecipeIdFromCharm,
  injectUserCode,
} from "@commontools/charm";
import { IFrameRecipe } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useNavigate, useParams } from "react-router-dom";
import { type CharmRouteParams, createPath } from "@/routes.ts";
import { Cell, RuntimeProgram } from "@commontools/runner";
import type { Source } from "@commontools/js-runtime";
import { useRuntime } from "@/contexts/RuntimeContext.tsx";

export interface UseMultiFileEditorReturn {
  files: Source[];
  setFiles: (files: Source[]) => void;
  activeFile: string;
  setActiveFile: (name: string) => void;
  addFile: (name: string, contents?: string) => void;
  deleteFile: (name: string) => void;
  renameFile: (oldName: string, newName: string) => void;
  updateFileContent: (name: string, contents: string) => void;
  hasUnsavedChanges: boolean;
  saveChanges: (createNew?: boolean) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
  isMultiFile: boolean;
  workingSpec: string;
  setWorkingSpec: (v: string) => void;
  workingArgumentSchema: string;
  setWorkingArgumentSchema: (v: string) => void;
  workingResultSchema: string;
  setWorkingResultSchema: (v: string) => void;
  hasSpecChanges: boolean;
  hasSchemaChanges: boolean;
}

export function useMultiFileEditor(
  charm?: Cell<Charm>,
  iframeRecipe?: IFrameRecipe,
  regularRecipeSource?: string,
): UseMultiFileEditorReturn {
  const { charmManager } = useCharmManager();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { replicaName } = useParams<CharmRouteParams>();

  // Loading flag shared with save operation
  const [loading, setLoading] = useState(false);

  // Files state
  const [files, setFiles] = useState<Source[]>([]);
  const [activeFile, setActiveFile] = useState<string>("");
  const [initialFiles, setInitialFiles] = useState<Source[]>([]);

  // Spec/Schema states (for iframe recipes)
  const [workingSpec, setWorkingSpecState] = useState<string>("");
  const [initialSpec, setInitialSpec] = useState<string>("");
  const [workingArgumentSchema, setWorkingArgumentSchemaState] = useState<
    string
  >("{}");
  const [workingResultSchema, setWorkingResultSchemaState] = useState<string>(
    "{}",
  );

  // Determine if this recipe uses multi-file format
  const [isMultiFile, setIsMultiFile] = useState(false);
  const [mainExport, setMainExport] = useState<string | undefined>(undefined);
  const [mainFile, setMainFile] = useState<string>("");

  // Initialize content when charm/recipe changes
  useEffect(() => {
    if (!charm) return;

    const recipeId = getRecipeIdFromCharm(charm);
    if (!recipeId) return;

    const recipeMeta = runtime.recipeManager.getRecipeMeta({ recipeId });

    if (recipeMeta?.program) {
      // Multi-file recipe
      setIsMultiFile(true);
      setMainExport(recipeMeta.program.mainExport);
      setMainFile(recipeMeta.program.main || "/main.tsx");
      const sourceFiles = recipeMeta.program.files.map((f: Source) => ({
        name: f.name,
        contents: f.contents,
      }));
      setFiles(sourceFiles);
      setInitialFiles(sourceFiles);
      if (sourceFiles.length > 0 && !activeFile) {
        setActiveFile(sourceFiles[0].name);
      }
    } else if (iframeRecipe) {
      // Single file iframe recipe
      setIsMultiFile(false);
      const userCode = extractUserCode(iframeRecipe.src ?? "") ?? "";
      const singleFile: Source = {
        name: "/main.iframe.js",
        contents: userCode,
      };
      setFiles([singleFile]);
      setInitialFiles([singleFile]);
      setActiveFile(singleFile.name);

      // Set spec and schemas for iframe recipes
      setWorkingSpecState(iframeRecipe.spec ?? "");
      setInitialSpec(iframeRecipe.spec ?? "");
      setWorkingArgumentSchemaState(
        JSON.stringify(iframeRecipe.argumentSchema || {}, null, 2),
      );
      setWorkingResultSchemaState(
        JSON.stringify(iframeRecipe.resultSchema || {}, null, 2),
      );
    } else if (regularRecipeSource) {
      // Single file regular recipe
      setIsMultiFile(false);
      const singleFile: Source = {
        name: "/main.tsx",
        contents: regularRecipeSource,
      };
      setFiles([singleFile]);
      setInitialFiles([singleFile]);
      setActiveFile(singleFile.name);
    }
  }, [charm, iframeRecipe, regularRecipeSource, runtime]);

  // File operations
  const addFile = useCallback((name: string, contents: string = "") => {
    // Ensure name starts with /
    if (!name.startsWith("/")) {
      name = "/" + name;
    }

    setFiles((prev) => {
      if (prev.some((f) => f.name === name)) {
        return prev; // File already exists
      }
      return [...prev, { name, contents }];
    });
    setActiveFile(name);
  }, []);

  const deleteFile = useCallback((name: string) => {
    setFiles((prev) => {
      const newFiles = prev.filter((f) => f.name !== name);
      if (activeFile === name && newFiles.length > 0) {
        setActiveFile(newFiles[0].name);
      }
      return newFiles;
    });
  }, [activeFile]);

  const renameFile = useCallback((oldName: string, newName: string) => {
    // Ensure newName starts with /
    if (!newName.startsWith("/")) {
      newName = "/" + newName;
    }

    setFiles((prev) =>
      prev.map((f) => f.name === oldName ? { ...f, name: newName } : f)
    );
    if (activeFile === oldName) {
      setActiveFile(newName);
    }
  }, [activeFile]);

  const updateFileContent = useCallback((name: string, contents: string) => {
    setFiles((prev) =>
      prev.map((f) => f.name === name ? { ...f, contents } : f)
    );
  }, []);

  // Check for changes
  const hasFileChanges = files.length !== initialFiles.length ||
    files.some((file, idx) => {
      const initial = initialFiles.find((f) => f.name === file.name);
      return !initial || initial.contents !== file.contents;
    });

  const hasSpecChanges = workingSpec !== initialSpec;
  const hasSchemaChanges = iframeRecipe && (
    workingArgumentSchema !==
      JSON.stringify(iframeRecipe.argumentSchema || {}, null, 2) ||
    workingResultSchema !==
      JSON.stringify(iframeRecipe.resultSchema || {}, null, 2)
  );

  const hasUnsavedChanges = hasFileChanges || hasSpecChanges ||
    !!hasSchemaChanges;

  // Wrapper functions for spec/schema setters
  const setWorkingSpec = (v: string) => setWorkingSpecState(v);
  const setWorkingArgumentSchema = (v: string) =>
    setWorkingArgumentSchemaState(v);
  const setWorkingResultSchema = (v: string) => setWorkingResultSchemaState(v);

  // Save logic
  const saveChanges = useCallback(async (createNew: boolean = true) => {
    if (!charm) return;

    setLoading(true);

    try {
      const recipeId = getRecipeIdFromCharm(charm);

      if (files.length === 1 && iframeRecipe) {
        // Single file iframe recipe
        const src = injectUserCode(files[0].contents);

        // Parse schemas if they've changed
        let parsedArgSchema = iframeRecipe.argumentSchema;
        let parsedResultSchema = iframeRecipe.resultSchema;

        if (hasSchemaChanges) {
          try {
            parsedArgSchema = JSON.parse(workingArgumentSchema);
            parsedResultSchema = JSON.parse(workingResultSchema);
          } catch (err) {
            console.error("Error parsing schema:", err);
            setLoading(false);
            return;
          }
        }

        // Create a modified recipe that includes the schema changes
        const updatedRecipe: IFrameRecipe = {
          ...iframeRecipe,
          src: src,
          spec: workingSpec,
          argumentSchema: parsedArgSchema,
          resultSchema: parsedResultSchema,
        };

        if (createNew) {
          const newCharm = await generateNewRecipeVersion(
            charmManager,
            charm,
            updatedRecipe,
          );

          if (newCharm && replicaName) {
            navigate(
              createPath("charmShow", {
                charmId: charmId(newCharm)!,
                replicaName,
              }),
            );
          }
        } else {
          // Update existing charm in place by running the updated recipe
          const fullSrc = buildFullRecipe(updatedRecipe);
          const recipe = await compileRecipe(
            fullSrc,
            "recipe",
            runtime,
            charmManager.getSpace(),
            recipeId ? [recipeId] : undefined,
          );

          // Get the existing charm's ID and argument
          const existingCharmId = charmId(charm);
          if (!existingCharmId) {
            throw new Error("Could not get charm ID");
          }

          const argument = charmManager.getArgument(charm);

          // Run the updated recipe on the same charm ID
          await charmManager.runWithRecipe(
            recipe,
            existingCharmId,
            argument?.get(),
          );

          // Stay on the same charm
          await runtime.idle();
        }
      } else if (files.length === 1 && !iframeRecipe) {
        // Single file regular recipe
        const recipeMeta = runtime.recipeManager.getRecipeMeta({ recipeId });
        const spec = recipeMeta?.spec || "";
        const argument = charmManager.getArgument(charm);

        if (createNew) {
          const { compileAndRunRecipe } = await import("@commontools/charm");
          const newCharm = await compileAndRunRecipe(
            charmManager,
            files[0].contents,
            spec,
            argument,
            recipeId ? [recipeId] : undefined,
          );

          if (newCharm && replicaName) {
            navigate(
              createPath("charmShow", {
                charmId: charmId(newCharm)!,
                replicaName,
              }),
            );
          }
        } else {
          // Update existing charm in place
          const recipe = await compileRecipe(
            files[0].contents,
            "recipe",
            runtime,
            charmManager.getSpace(),
            recipeId ? [recipeId] : undefined,
          );

          const existingCharmId = charmId(charm);
          if (!existingCharmId) {
            throw new Error("Could not get charm ID");
          }

          await charmManager.runWithRecipe(
            recipe,
            existingCharmId,
            argument?.get(),
          );

          // Stay on the same charm
          await runtime.idle();
        }
      } else {
        // Multi-file recipe
        const program: RuntimeProgram = {
          main: mainFile || files[0].name,
          files: files,
          mainExport: mainExport,
        };

        const recipeMeta = runtime.recipeManager.getRecipeMeta({ recipeId });
        const spec = recipeMeta?.spec || workingSpec || "";
        const argument = charmManager.getArgument(charm);

        const recipe = await compileRecipe(
          program,
          "recipe",
          runtime,
          charmManager.getSpace(),
          recipeId ? [recipeId] : undefined,
        );

        if (createNew) {
          const newCharm = await charmManager.runPersistent(
            recipe,
            argument,
            [charm], // parent
          );

          if (newCharm && replicaName) {
            navigate(
              createPath("charmShow", {
                charmId: charmId(newCharm)!,
                replicaName,
              }),
            );
          }
        } else {
          // Update existing charm in place
          const existingCharmId = charmId(charm);
          if (!existingCharmId) {
            throw new Error("Could not get charm ID");
          }

          await charmManager.runWithRecipe(
            recipe,
            existingCharmId,
            argument?.get(),
          );

          // Stay on the same charm
          await runtime.idle();
        }
      }
    } catch (error) {
      console.error("Error saving recipe:", error);
    } finally {
      setLoading(false);
    }
  }, [
    charm,
    files,
    iframeRecipe,
    workingSpec,
    workingArgumentSchema,
    workingResultSchema,
    charmManager,
    navigate,
    replicaName,
    hasSchemaChanges,
    runtime,
  ]);

  return {
    files,
    setFiles,
    activeFile,
    setActiveFile,
    addFile,
    deleteFile,
    renameFile,
    updateFileContent,
    hasUnsavedChanges,
    saveChanges,
    loading,
    setLoading,
    isMultiFile,
    workingSpec,
    setWorkingSpec,
    workingArgumentSchema,
    setWorkingArgumentSchema,
    workingResultSchema,
    setWorkingResultSchema,
    hasSpecChanges,
    hasSchemaChanges: !!hasSchemaChanges,
  };
}
