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
import { FeedbackActions } from "@/components/FeedbackActions.tsx";
import JobStatus from "@/components/JobStatus.tsx";

export default function Shell() {
  const { charmId } = useParams<CharmRouteParams>();
  useGlobalActions();
  const { session } = useAuthentication();

  if (!session) {
    return <AuthenticationView />;
  }

  return (
    <CharmsManagerProvider>
      <SyncStatusProvider>
        <NetworkInspectorProvider>
          <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
            <ShellHeader session={session} charmId={charmId} />

            <div className="h-full overflow-y-auto">
              <Outlet />
            </div>

            <ActionBar />
            <CharmPublisher />
            <CommandCenter />
            <FeedbackActions />
            <ToggleableNetworkInspector
              visible={localStorage.getItem("networkInspectorVisible") ===
                "true"}
            />
            <JobStatus className="floating-panel" />
          </div>
        </NetworkInspectorProvider>
      </SyncStatusProvider>
    </CharmsManagerProvider>
  );
}
