import { useParams } from "react-router-dom";

import { CharmRenderer } from "@/components/CharmRunner";
import { LoadingSpinner } from "@/components/Loader";
import { useCharm } from "@/hooks/use-charm";

function CharmShowView() {
  const { charmId } = useParams();
  const { currentFocus: charm } = useCharm(charmId);

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible={true} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {charm && <CharmRenderer className="w-full h-full" charm={charm} />}
    </div>
  );
}

export default CharmShowView;
