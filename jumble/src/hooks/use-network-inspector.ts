import { useEffect, useState } from "react";

export function useNetworkInspector() {
  const [visible, setVisible] = useState(false);

  // On first render, check localStorage for saved preference
  useEffect(() => {
    const updateFromStorage = () => {
      const savedPreference = localStorage.getItem("networkInspectorVisible");
      if (savedPreference !== null) {
        setVisible(savedPreference === "true");
      }
    };

    // Initialize from localStorage
    updateFromStorage();

    // Listen for changes in localStorage (for cross-tab synchronization)
    window.addEventListener("storage", updateFromStorage);
    
    // Also listen for our custom event for same-tab updates
    window.addEventListener("networkInspectorUpdate", updateFromStorage);

    return () => {
      window.removeEventListener("storage", updateFromStorage);
      window.removeEventListener("networkInspectorUpdate", updateFromStorage);
    };
  }, []);

  // Update localStorage when the visible state changes
  const toggleVisibility = (value?: boolean) => {
    const newValue = value !== undefined ? value : !visible;
    setVisible(newValue);
    localStorage.setItem("networkInspectorVisible", String(newValue));
    
    // Dispatch an event to notify other components about the change
    window.dispatchEvent(new Event("networkInspectorUpdate"));
  };

  return {
    visible,
    toggleVisibility,
    show: () => toggleVisibility(true),
    hide: () => toggleVisibility(false),
  };
}