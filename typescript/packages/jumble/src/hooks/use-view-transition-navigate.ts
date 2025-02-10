import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useViewTransitionNavigate() {
  const navigate = useNavigate();

  const viewTransitionNavigate = useCallback(
    (to: string) => {
      if (!document.startViewTransition) {
        navigate(to);
        return;
      }

      document.startViewTransition(() => {
        navigate(to);
      });
    },
    [navigate],
  );

  return viewTransitionNavigate;
}
