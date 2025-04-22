import "@commontools/ui";
import { useLocation, useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import {
  MdEdit,
  MdOutlineStar,
  MdRemoveRedEye,
  MdSend,
  MdShare,
} from "react-icons/md";

import { useAction } from "@/contexts/ActionManagerContext.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { NAME } from "@commontools/builder";

export function useGlobalActions() {
  const { charmId, replicaName } = useParams<CharmRouteParams>();
  const location = useLocation();

  const isDetailActive = location.pathname.endsWith("/detail");
  const togglePath = isDetailActive
    ? `/${replicaName}/${charmId}`
    : `/${replicaName}/${charmId}/detail`;

  // Command palette action (always available)
  useAction(
    useMemo(
      () => ({
        id: "command-palette",
        label: "Commands",
        icon: <MdOutlineStar fill="black" size={28} />,
        onClick: () => {
          globalThis.dispatchEvent(new CustomEvent("open-command-center"));
        },
        priority: 100,
      }),
      [],
    ),
  );

  const hasCharmId = useCallback(() => Boolean(charmId), [charmId]);

  const { charmManager } = useCharmManager();
  const [charmName, setCharmName] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let cancel: (() => void) | undefined;

    async function getCharm() {
      if (charmId && charmManager) {
        const charm = await charmManager.get(charmId);
        cancel = charm?.key(NAME).sink((value) => {
          if (mounted) setCharmName(value ?? null);
        });
      }
    }
    getCharm();

    return () => {
      mounted = false;
      cancel?.();
    };
  }, [charmId, charmManager]);

  useAction(
    useMemo(
      () => ({
        id: "publish",
        label: "Publish",
        icon: <MdShare fill="black" size={28} />,
        onClick: () => {
          globalThis.dispatchEvent(
            new CustomEvent("publish-charm", {
              detail: { charmId, charmName },
            }),
          );
        },
        predicate: hasCharmId,
        priority: 100,
      }),
      [hasCharmId, charmId, charmName],
    ),
  );

  // Edit action (conditional)
  useAction(
    useMemo(
      () => ({
        id: "link:edit-charm",
        label: isDetailActive ? "View" : "Edit",
        icon: isDetailActive
          ? <MdRemoveRedEye size={28} />
          : <MdEdit size={28} />,
        to: togglePath,
        onClick: () => {},
        predicate: hasCharmId,
        priority: 50,
      }),
      [hasCharmId, togglePath, isDetailActive],
    ),
  );

  // Track if current charm has LLM trace ID for feedback
  const [hasLLMTrace, setHasLLMTrace] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function checkLLMTrace() {
      if (charmId && charmManager) {
        const charm = await charmManager.get(charmId);
        if (charm && mounted) {
          const traceId = charmManager.getLLMTrace(charm);
          setHasLLMTrace(
            !!traceId && typeof traceId === "string" && traceId.trim() !== "",
          );
        }
      }
    }

    checkLLMTrace();
    return () => {
      mounted = false;
    };
  }, [charmId, charmManager]);

  // Feedback action (available only when a charm with LLM trace is open)
  useAction(
    useMemo(
      () => ({
        id: "feedback-toggle",
        label: "Feedback",
        icon: <MdSend size={24} />,
        onClick: () => {
          globalThis.dispatchEvent(new CustomEvent("toggle-feedback"));
        },
        priority: 30,
        predicate: () => hasCharmId() && hasLLMTrace,
      }),
      [hasCharmId, hasLLMTrace],
    ),
  );
}
