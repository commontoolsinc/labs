import "@commontools/ui";
import { Outlet, useParams } from "react-router-dom";

import ShellHeader from "@/components/ShellHeader.tsx";
import { CommandCenter } from "@/components/CommandCenter.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { AuthenticationView } from "@/views/AuthenticationView.tsx";
import { ActionBar } from "@/components/ActionBar.tsx";
import { CharmPublisher } from "@/components/Publish.tsx";
import { useGlobalActions } from "@/hooks/use-global-actions.tsx";

export default function Shell() {
  const { charmId, replicaName } = useParams();
  useGlobalActions();
  const { user } = useAuthentication();

  if (!user) {
    return <AuthenticationView />;
  }

  return (
    <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
      <ShellHeader replicaName={replicaName} charmId={charmId} />

      <div className="relative h-full">
        <Outlet />
      </div>

      <ActionBar />
      <CharmPublisher />
      <CommandCenter />
    </div>
  );
}
