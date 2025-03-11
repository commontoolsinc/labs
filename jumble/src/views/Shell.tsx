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

export default function Shell() {
  const { charmId, replicaName } = useParams<CharmRouteParams>();
  useGlobalActions();
  const { user } = useAuthentication();

  if (!user) {
    return <AuthenticationView />;
  }

  return (
    <CharmsManagerProvider>
      <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
        <ShellHeader replicaName={replicaName} charmId={charmId} />

        <div className="relative h-full overflow-y-auto">
          <Outlet />
        </div>

        <ActionBar />
        <CharmPublisher />
        <CommandCenter />
      </div>
    </CharmsManagerProvider>
  );
}
