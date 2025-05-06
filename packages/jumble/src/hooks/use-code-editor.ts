import { useCallback, useEffect, useState } from "react";
import {
  Charm,
  charmId,
  extractUserCode,
  generateNewRecipeVersion,
  injectUserCode,
} from "@commontools/charm";
import { IFrameRecipe } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useNavigate, useParams } from "react-router-dom";
import { type CharmRouteParams, createPath } from "@/routes.ts";
import { Cell } from "@commontools/runner";

export interface UseCodeEditorReturn {
  fullSrc: string;
  workingSrc: string;
  setWorkingSrc: (v: string) => void;
  workingSpec: string;
  setWorkingSpec: (v: string) => void;
  workingArgumentSchema: string;
  setWorkingArgumentSchema: (v: string) => void;
  workingResultSchema: string;
  setWorkingResultSchema: (v: string) => void;
  hasSourceChanges: boolean;
  hasSpecChanges: boolean;
  hasSchemaChanges: boolean;
  hasUnsavedChanges: boolean;
  saveChanges: () => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
}

export function useCodeEditor(
  charm?: Cell<Charm>,
  iframeRecipe?: IFrameRecipe,
  showFullCode: boolean = false,
): UseCodeEditorReturn {
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();
  const { replicaName } = useParams<CharmRouteParams>();

  // Loading flag shared with save operation
  const [loading, setLoading] = useState(false);

  // Source / Spec
  const [workingSrc, setWorkingSrcState] = useState<string>("");
  const [workingSpec, setWorkingSpecState] = useState<string>("");
  const [initialSpec, setInitialSpec] = useState<string>("");

  // Schemas
  const [workingArgumentSchema, setWorkingArgumentSchemaState] = useState<
    string
  >("{}");
  const [workingResultSchema, setWorkingResultSchemaState] = useState<string>(
    "{}",
  );

  // Initialize content when charm/recipe changes
  useEffect(() => {
    if (charm && iframeRecipe) {
      if (showFullCode) {
        setWorkingSrcState(iframeRecipe.src ?? "");
      } else {
        setWorkingSrcState(extractUserCode(iframeRecipe.src ?? "") ?? "");
      }
      setWorkingSpecState(iframeRecipe.spec ?? "");
      setInitialSpec(iframeRecipe.spec ?? "");
      setWorkingArgumentSchemaState(
        JSON.stringify(iframeRecipe.argumentSchema || {}, null, 2),
      );
      setWorkingResultSchemaState(
        JSON.stringify(iframeRecipe.resultSchema || {}, null, 2),
      );
    }
  }, [charm, iframeRecipe, showFullCode]);

  // Derived flags for changes
  const hasSourceChanges = showFullCode
    ? workingSrc !== iframeRecipe?.src
    : injectUserCode(workingSrc) !== iframeRecipe?.src;

  const hasSpecChanges = workingSpec !== initialSpec;

  const hasSchemaChanges = workingArgumentSchema !==
      JSON.stringify(iframeRecipe?.argumentSchema || {}, null, 2) ||
    workingResultSchema !==
      JSON.stringify(iframeRecipe?.resultSchema || {}, null, 2);

  const hasUnsavedChanges = hasSourceChanges || hasSpecChanges ||
    hasSchemaChanges;

  // Wrapper functions for state setters
  const setWorkingSrc = (v: string) => setWorkingSrcState(v);
  const setWorkingSpec = (v: string) => setWorkingSpecState(v);
  const setWorkingArgumentSchema = (v: string) =>
    setWorkingArgumentSchemaState(v);
  const setWorkingResultSchema = (v: string) => setWorkingResultSchemaState(v);

  // Save logic with schema support
  const saveChanges = useCallback(() => {
    if (!charm || !iframeRecipe) return;

    const src = showFullCode ? workingSrc : injectUserCode(workingSrc);

    setLoading(true);

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

    // Handle spec & src changes (existing behaviour)
    const promise = generateNewRecipeVersion(
      charmManager,
      charm,
      updatedRecipe,
    ).then((newCharm) => {
      if (!newCharm) return;
      if (replicaName) {
        navigate(
          createPath("charmShow", { charmId: charmId(newCharm)!, replicaName }),
        );
      }
    });

    promise.catch((e) => console.error(e)).finally(() => setLoading(false));
  }, [
    charm,
    iframeRecipe,
    workingSrc,
    workingSpec,
    workingArgumentSchema,
    workingResultSchema,
    charmManager,
    showFullCode,
    navigate,
    replicaName,
    hasSchemaChanges,
  ]);

  return {
    fullSrc: iframeRecipe?.src ?? "",
    workingSrc,
    setWorkingSrc,
    workingSpec,
    setWorkingSpec,
    workingArgumentSchema,
    setWorkingArgumentSchema,
    workingResultSchema,
    setWorkingResultSchema,
    hasSourceChanges,
    hasSpecChanges,
    hasSchemaChanges,
    hasUnsavedChanges,
    saveChanges,
    loading,
    setLoading,
  };
}
