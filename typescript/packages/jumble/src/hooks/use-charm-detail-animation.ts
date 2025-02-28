import { useSpring } from "@react-spring/web";
import React from "react";

export const useCharmDetailAnimations = (details: boolean) => {
  const [scrollProgress, setScrollProgress] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const calculateScrollProgress = () => {
      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight - container.clientHeight;
      const progress = scrollHeight > 0 ? scrollTop / scrollHeight : 0;
      setScrollProgress(progress);
    };

    calculateScrollProgress();
    container.addEventListener("scroll", calculateScrollProgress);

    if (details) {
      setScrollProgress(0);
      container.scrollTo(0, 0);
    }

    return () => {
      container.removeEventListener("scroll", calculateScrollProgress);
    };
  }, [details]);

  const charmSpring = useSpring({
    scale: details ? 0.45 : 1,
    borderRadius: details ? "16px" : "0px",
    opacity: details
      ? (() => {
        if (scrollProgress < 0.5) return 1;
        if (scrollProgress > 0.8) return 0;
        return 1 - (scrollProgress - 0.5) / 0.3;
      })()
      : 1,
    transform: details
      ? (() => {
        const baseScale = 1;
        if (scrollProgress < 0.5) return `scale(${baseScale})`;
        if (scrollProgress > 0.8) return `scale(0)`;
        return `scale(${baseScale * (1 - (scrollProgress - 0.5) / 0.3)})`;
      })()
      : "scale(1)",
    config: { tension: 400, friction: 38 },
  });

  const detailsSpring = useSpring({
    opacity: details ? 1 : 0,
    scale: details ? 1 : 0.95,
    filter: details ? "blur(0px)" : "blur(10px)",
    config: { tension: 400, friction: 38 },
  });

  return {
    containerRef,
    scrollProgress,
    charmSpring,
    detailsSpring,
  };
};
