import { useEffect, useState } from "react";

const STORAGE_KEY = "networkInspectorVisible";
const STORAGE_EVENT = "storage";

export function useNetworkInspector() {
  const [visible, setVisible] = useState(false);

  // On first render, check localStorage for saved preference
  useEffect(() => {
    const updateFromStorage = () => {
      const savedPreference = localStorage.getItem(STORAGE_KEY);
      if (savedPreference !== null) {
        setVisible(savedPreference === "true");
      }
    };

    // Initialize from localStorage
    updateFromStorage();

    // Listen for changes in localStorage (for cross-tab synchronization)
    globalThis.addEventListener(STORAGE_EVENT, updateFromStorage);

    return () => {
      globalThis.removeEventListener(STORAGE_EVENT, updateFromStorage);
    };
  }, []);

  // Update localStorage when the visible state changes
  const toggleVisibility = (value?: boolean) => {
    const newValue = value !== undefined ? value : !visible;
    setVisible(newValue);
    localStorage.setItem(STORAGE_KEY, String(newValue));
  };

  return {
    visible,
    toggleVisibility,
    show: () => toggleVisibility(true),
    hide: () => toggleVisibility(false),
  };
}
