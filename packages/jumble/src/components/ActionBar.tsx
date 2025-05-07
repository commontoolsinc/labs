import { animated } from "@react-spring/web";
import { useActionManager } from "../contexts/ActionManagerContext.tsx";
import { NavLink } from "react-router-dom";
import { ReactNode } from "react";

const ActionButton = (
  { children, label }: { children: ReactNode; label: string },
) => (
  <>
    {children}
    <div className="absolute top-[-40px] left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
      {label}
    </div>
  </>
);

const actionButtonStyles = `
  flex items-center justify-center w-12 h-12
  border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
  hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
  transition-[border,box-shadow,transform] duration-100 ease-in-out
  bg-white cursor-pointer relative group
  touch-action-manipulation tap-highlight-color-transparent
`;

const actionButtonInlineStyles = {
  touchAction: "manipulation" as const,
  WebkitTapHighlightColor: "transparent",
};

export function ActionBar() {
  const { availableActions } = useActionManager();

  return (
    <div className="fixed bottom-2 right-2 z-50 flex flex-row gap-2">
      {availableActions.map((action) => {
        if (action.id.startsWith("link:") && action.to) {
          return (
            <NavLink
              key={action.id}
              to={action.to}
              className={`${actionButtonStyles} ${action.className || ""}`}
              style={actionButtonInlineStyles}
            >
              <ActionButton label={action.label}>
                {action.icon}
              </ActionButton>
            </NavLink>
          );
        }

        return (
          <animated.button
            key={action.id}
            className={`${actionButtonStyles} ${action.className || ""}`}
            style={actionButtonInlineStyles}
            onClick={action.onClick}
          >
            <ActionButton label={action.label}>
              {action.icon}
            </ActionButton>
          </animated.button>
        );
      })}
    </div>
  );
}
