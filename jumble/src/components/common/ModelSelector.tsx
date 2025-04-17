import React, { useMemo, useState } from "react";
import { User } from "@/components/User.tsx";
import { useCell, useNamedCell } from "@/hooks/use-cell.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { DEFAULT_MODEL_NAME } from "@commontools/llm/types";

// Define the model options - these can be expanded in the future
const MODEL_OPTIONS = [
  // Preset section
  {
    value: DEFAULT_MODEL_NAME,
    label: "Default",
    isPreset: true,
  },
  { value: "openai:gpt-4.1-nano", label: "Fast", isPreset: true },
  { value: "google:gemini-2.5-pro", label: "Experimental", isPreset: true },
  // Full model list
  {
    value: "anthropic:claude-3-7-sonnet-latest",
    label: "Claude 3.7 ✨",
    isPreset: false,
  },
  { value: "google:gemini-2.5-pro", label: "Gemini 2.5 ✨", isPreset: false },
  {
    value: "anthropic:claude-3-5-sonnet-latest",
    label: "Claude 3.5",
    isPreset: false,
  },
  { value: "groq:qwen-qwq-32b", label: "Qwen QwQ 32B", isPreset: false },
  {
    value: "groq:llama-3.3-70b-versatile",
    label: "Llama 3.3 🔥",
    isPreset: false,
  },
  {
    value: "groq:llama-4-maverick",
    label: "Llama 4 Maverick",
    isPreset: false,
  },
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
  },
  { value: "google:gemini-2.0-pro", label: "Gemini 2.0", isPreset: false },
  { value: "perplexity:sonar-pro", label: "Sonar Pro 🌐", isPreset: false },
];

export type LanguageModelId = typeof MODEL_OPTIONS[number]["value"];

export interface ModelOption {
  value: LanguageModelId;
  label: string;
  isPreset: boolean;
}

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  size?: "small" | "medium"; // Size variant
  showPresets?: boolean; // Whether to show preset section
  className?: string; // Additional classes
  mapPreview?: boolean; // Whether to map preview model values (think/fast) to actual models
}

export function useUserPreferredModel() {
  const { charmManager } = useCharmManager();
  const space = useMemo(() => charmManager.getSpace(), [charmManager]);
  const [userPreferredModel, setUserPreferredModel] = useNamedCell(
    space,
    "userPreferredModel",
    { type: "string" },
  );

  return { userPreferredModel, setUserPreferredModel };
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
