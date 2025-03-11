import { useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { useCharm } from "@/hooks/use-charm.ts";

function CharmShowView() {
  const { charmId } = useParams<CharmRouteParams>();
  const { currentFocus: charm } = useCharm(charmId);

  function test() {
  }

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" onClick={test}>
      {charm && <CharmRenderer className="w-full h-full" charm={charm} />}
    </div>
  );
}

export default CharmShowView;
