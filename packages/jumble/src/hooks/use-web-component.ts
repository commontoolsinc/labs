import React from "react";

// Export with a default export to be compatible with both import styles
export default function useWebComponent<P extends Record<string, any>>(
  ref: React.RefObject<HTMLElement>,
  props: P,
) {
  React.useEffect(() => {
    if (!ref.current) return;

    const element = ref.current;
    // Handle regular props
    Object.entries(props).forEach(([key, value]) => {
      if (!key.startsWith("on")) {
        if (key === "className") {
          element.setAttribute("class", value);
        } else if (typeof value === "boolean") {
          if (value) {
            element.setAttribute(key, "");
          } else {
            element.removeAttribute(key);
          }
        } else {
          (element as any)[key] = value;
        }
      }
    });

    // Handle event listeners
    const eventHandlers = Object.entries(props)
      .filter(([key]) => key.startsWith("on"))
      .map(([key, handler]) => {
        // Convert onEventName to event-name
        const eventName = key
          .slice(2)
          .split(/(?=[A-Z])/)
          .map((part) => part.toLowerCase())
          .join("-");
        return { eventName, handler };
      });

    // Add event listeners
    eventHandlers.forEach(({ eventName, handler }) => {
      element.addEventListener(eventName, handler);
    });

    // Cleanup
    return () => {
      eventHandlers.forEach(({ eventName, handler }) => {
        element.removeEventListener(eventName, handler);
      });
    };
  }, [ref, props]);
}
