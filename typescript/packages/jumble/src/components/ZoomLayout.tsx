import { useLocation } from "react-router-dom";
import { animated, useTransition } from "@react-spring/web";

export function ZoomLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  const transitions = useTransition(location, {
    from: {
      opacity: location.pathname === "/" ? 1 : 0,
      filter: location.pathname === "/" ? "blur(0px)" : "blur(10px)",
      transform: location.pathname === "/" ? "scale(1)" : "scale(0.7)",
    },
    enter: {
      opacity: 1,
      filter: "blur(0px)",
      transform: "scale(1)",
    },
    leave: {
      opacity: location.pathname === "/" ? 1 : 0,
      filter: location.pathname === "/" ? "blur(0px)" : "blur(10px)",
      transform: location.pathname === "/" ? "scale(1)" : "scale(1.3)",
    },
    config: {
      tension: 400,
      friction: 38,
    },
  });

  return transitions((style, _item) => (
    <animated.div
      style={{
        ...style,
        position: "absolute",
        width: "100%",
        height: "100%",
      }}
    >
      {children}
    </animated.div>
  ));
}
