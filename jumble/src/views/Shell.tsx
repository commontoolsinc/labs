import "@commontools/ui";
import { Outlet, useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import ShellHeader from "@/components/ShellHeader.tsx";
import { CharmsManagerProvider } from "@/contexts/CharmManagerContext.tsx";
import { CommandCenter } from "@/components/CommandCenter.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { AuthenticationView } from "@/views/AuthenticationView.tsx";
import { ActionBar } from "@/components/ActionBar.tsx";
import { CharmPublisher } from "@/components/Publish.tsx";
import { useGlobalActions } from "@/hooks/use-global-actions.tsx";
import { SyncStatusProvider } from "@/contexts/SyncStatusContext.tsx";
import { ToggleableNetworkInspector } from "@/components/NetworkInspector.tsx";
import { NetworkInspectorProvider } from "@/contexts/NetworkInspectorContext.tsx";
import { PrimaryFeedbackActions } from "@/components/FeedbackActions.tsx";
import ActivityStatus from "@/components/ActivityStatus.tsx";
import { useCharm } from "@/hooks/use-charm.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useEffect, useState } from "react";

export default function Shell() {
  const { charmId } = useParams<CharmRouteParams>();
  const { session } = useAuthentication();
  
  if (!session) {
    return <AuthenticationView />;
  }

  return (
    <CharmsManagerProvider>
      <ShellContent charmId={charmId} />
    </CharmsManagerProvider>
  );
}

function ShellContent({ charmId }: { charmId?: string }) {
  const { currentFocus: charm } = useCharm(charmId);
  const { charmManager } = useCharmManager();
  const { session } = useAuthentication();
  // We don't need a custom toggle handler - PrimaryFeedbackActions handles its own state
  
  useGlobalActions();

  return (
    <SyncStatusProvider>
      <NetworkInspectorProvider>
        <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
          <ShellHeader session={session!} charmId={charmId} />

          <div className="h-full overflow-y-auto">
            <Outlet />
          </div>

          <ActionBar />
          <CharmPublisher />
          <CommandCenter />
          {charm && charmManager && (() => {
            const traceId = charmManager.getLLMTrace(charm);
            return traceId && typeof traceId === 'string' && traceId.trim() !== '' ? 
              <PrimaryFeedbackActions llmRequestId={traceId} /> : null;
          })()}
          <ToggleableNetworkInspector
            visible={localStorage.getItem("networkInspectorVisible") ===
              "true"}
          />
          <ActivityStatus className="floating-panel" />
        </div>
      </NetworkInspectorProvider>
    </SyncStatusProvider>
  );
}
