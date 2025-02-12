import { useParams } from "react-router-dom";

import { CharmRenderer } from "@/components/CharmRunner";
import { LoadingSpinner } from "@/components/Loader";
import { useCharm } from "@/hooks/use-charm";

function CharmDetail() {
  console.log("WAT");
  const { charmId } = useParams();
  const { currentFocus: charm } = useCharm(charmId);

  console.log("charm", charm);
  console.log("charmId", charmId);

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

export default CharmDetail;
