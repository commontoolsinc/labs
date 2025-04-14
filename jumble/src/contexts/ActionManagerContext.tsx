import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type KeyCombo = {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
};

export type Action = {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  predicate?: () => boolean;
  priority?: number;
  to?: string; // For NavLink actions
  keyCombo?: KeyCombo; // Keyboard shortcut
  className?: string; // Optional CSS class for styling the button
};

type ActionManagerContextType = {
  registerAction: (action: Action) => () => void; // Returns unregister function
  availableActions: Action[];
};

const ActionManagerContext = createContext<ActionManagerContextType | null>(
  null,
);

export function ActionManagerProvider(
  { children }: { children: React.ReactNode },
) {
  const [actions, setActions] = useState<Action[]>([]);

  // Combined register function that returns an unregister function
  const registerAction = useCallback((action: Action) => {
    setActions((prev) => {
      // Don't add if it already exists with the same ID
      if (prev.some((a) => a.id === action.id)) {
        return prev;
      }
      return [...prev, action];
    });

    // Handle keyboard shortcut registration
    const handleKeyDown = (event: KeyboardEvent) => {
      const combo = action.keyCombo;
      if (!combo) return;

      if (
        event.key.toLowerCase() === combo.key.toLowerCase() &&
        !!event.ctrlKey === !!combo.ctrl &&
        !!event.altKey === !!combo.alt &&
        !!event.shiftKey === !!combo.shift &&
        !!event.metaKey === !!combo.meta
      ) {
        if (!action.predicate || action.predicate()) {
          event.preventDefault();
          action.onClick();
        }
      }
    };

    // Register keyboard listener if keyCombo exists
    if (action.keyCombo) {
      globalThis.addEventListener("keydown", handleKeyDown);
    }

    // Return a function to unregister this action and clean up event listeners
    return () => {
      setActions((prev) => prev.filter((a) => a.id !== action.id));
      if (action.keyCombo) {
        globalThis.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, []);

  // Calculate available actions
  const availableActions = useMemo(() => {
    return actions
      .filter((action) => !action.predicate || action.predicate())
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }, [actions]);

  const value = useMemo(
    () => ({
      registerAction,
      availableActions,
    }),
    [registerAction, availableActions],
  );

  return (
    <ActionManagerContext.Provider value={value}>
      {children}
    </ActionManagerContext.Provider>
  );
}

export function useActionManager() {
  const context = useContext(ActionManagerContext);
  if (!context) {
    throw new Error(
      "useActionManager must be used within an ActionManagerProvider",
    );
  }
  return context;
}

// Simple hook for a component to register an action
export function useAction(action: Action) {
  const { registerAction } = useActionManager();

  // Register on mount, unregister on unmount
  useEffect(() => {
    const unregister = registerAction(action);
    return unregister;
  }, [action, registerAction]); // Only re-register if ID changes
}
