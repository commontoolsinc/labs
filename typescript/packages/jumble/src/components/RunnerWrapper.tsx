import { useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";

// We now assume the recipe's render method returns a React element.
export interface RecipeFactory {
  render: () => React.ReactElement;
}

type RunnerWrapperProps = {
  recipeFactory: RecipeFactory;
};

export default function RunnerWrapper({ recipeFactory }: RunnerWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      const element = recipeFactory.render();
      createRoot(containerRef.current).render(element);
    }
  }, [recipeFactory]);

  return <div ref={containerRef} />;
}
