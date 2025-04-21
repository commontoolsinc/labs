import React, { useMemo, useSyncExternalStore } from "react";
import { User } from "@/components/User.tsx";
import { useCell, useNamedCell } from "@/hooks/use-cell.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { DEFAULT_MODEL_NAME } from "@commontools/llm/types";
import { DEFAULT_MODEL } from "../../../../charm/src/index.ts";

// Define the model options - these can be expanded in the future
const MODEL_OPTIONS = [
  // Preset section
  {
    value: DEFAULT_MODEL_NAME,
    label: "Default",
    isPreset: true,
  } as const,
  { value: "openai:gpt-4.1-nano", label: "Fast", isPreset: true } as const,
  {
    value: "google:gemini-2.5-pro",
    label: "Experimental",
    isPreset: true,
  } as const,
  // Full model list
  {
    value: "anthropic:claude-3-7-sonnet-latest",
    label: "Claude 3.7 ✨",
    isPreset: false,
  } as const,
  {
    value: "google:gemini-2.5-pro",
    label: "Gemini 2.5 ✨",
    isPreset: false,
  } as const,
  {
    value: "anthropic:claude-3-5-sonnet-latest",
    label: "Claude 3.5",
    isPreset: false,
  } as const,
  {
    value: "groq:qwen-qwq-32b",
    label: "Qwen QwQ 32B",
    isPreset: false,
  } as const,
  {
    value: "groq:llama-3.3-70b-versatile",
    label: "Llama 3.3 🔥",
    isPreset: false,
  } as const,
  { value: "openai:gpt-4.1", label: "gpt-4.1", isPreset: false } as const,
  {
    value: "openai:gpt-4.1-mini",
    label: "gpt-4.1-mini",
    isPreset: false,
  } as const,
  {
    value: "openai:gpt-4.1-nano",
    label: "gpt-4.1-nano",
    isPreset: false,
  } as const,
  {
    value: "openai:o3-mini-low-latest",
    label: "o3-mini-low",
    isPreset: false,
  } as const,
  {
    value: "groq:llama-4-maverick",
    label: "Llama 4 Maverick",
    isPreset: false,
  } as const,
  {
    value: "groq:llama-4-scout",
    label: "Llama 4 Scout",
    isPreset: false,
  },
  { value: "openai:o3", label: "o3 🧠", isPreset: false },
  { value: "openai:o4-mini-low", label: "o4-mini-low", isPreset: false },
  {
    value: "openai:o4-mini-medium",
    label: "o4-mini-medium",
    isPreset: false,
  },
  {
    value: "openai:o4-mini-high",
    label: "o4-mini-high",
    isPreset: false,
  } as const,
  {
    value: "google:gemini-2.0-pro",
    label: "Gemini 2.0",
    isPreset: false,
  } as const,
  {
    value: "perplexity:sonar-pro",
    label: "Sonar Pro 🌐",
    isPreset: false,
  } as const,
];

export type LanguageModelId = typeof MODEL_OPTIONS[number]["value"];

export interface ModelOption {
  value: LanguageModelId;
  label: string;
  isPreset: boolean;
}

interface ModelSelectorProps {
  value: LanguageModelId;
  onChange: (value: LanguageModelId) => void;
  size?: "small" | "medium"; // Size variant
  showPresets?: boolean; // Whether to show preset section
  className?: string; // Additional classes
  mapPreview?: boolean; // Whether to map preview model values (think/fast) to actual models
}
export function useUserPreferredModel() {
  // snapshot reader
  const getSnapshot = useMemo(() => {
    return () =>
      (localStorage.getItem("userPreferredModel") as LanguageModelId) ||
      DEFAULT_MODEL;
  }, []);

  // subscribe helper
  const subscribe = useMemo(() => {
    return (callback: () => void) => {
      globalThis.addEventListener("userPreferredModelChanged", callback);
      return () =>
        globalThis.removeEventListener("userPreferredModelChanged", callback);
    };
  }, []);

  const userPreferredModel = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot, // server snapshot - same as client
  );

  const setUserPreferredModel = (model: LanguageModelId) => {
    localStorage.setItem("userPreferredModel", model);
    globalThis.dispatchEvent(new Event("userPreferredModelChanged"));
  };

  return { userPreferredModel, setUserPreferredModel } as const;
}

/**
 * A consistent dropdown for selecting AI models across the application.
 * Supports both preset options and specific model selection.
 */
export function ModelSelector({
  value,
  onChange,
  size = "medium",
  showPresets = true,
  className = "",
  mapPreview = false,
}: ModelSelectorProps) {
  // Handle onChange to maintain original value format if needed
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
  };

  const sizeClasses = size === "small"
    ? "text-xs py-1 px-2"
    : "text-sm py-1.5 px-3";

  return (
    <select
      value={value}
      onChange={handleChange}
      className={`border-2 border-black bg-white ${sizeClasses} ${className}`}
      aria-label="Select AI model"
    >
      {/* Preset section */}
      {showPresets && (
        <>
          <optgroup label="Presets">
            {MODEL_OPTIONS.filter((option) => option.isPreset).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </>
      )}

      {/* Full model list */}
      <optgroup label="Models">
        {MODEL_OPTIONS.filter((option) => !option.isPreset).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
