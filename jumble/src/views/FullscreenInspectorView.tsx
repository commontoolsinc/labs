import { CharmsManagerProvider } from "@/contexts/CharmManagerContext.tsx";
import { ToggleableNetworkInspector } from "@/components/NetworkInspector.tsx";
import { NetworkInspectorProvider } from "@/contexts/NetworkInspectorContext.tsx";

export default function FullscreenInspectorView() {
  return (
    <NetworkInspectorProvider>
      <ToggleableNetworkInspector visible fullscreen />
    </NetworkInspectorProvider>
  );
}