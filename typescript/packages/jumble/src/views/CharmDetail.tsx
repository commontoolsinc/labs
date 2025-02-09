import { Charm, saveNewRecipeVersion } from "@commontools/charm";
import React from "react";
import { useParams } from "react-router-dom";
import { CharmRenderer } from "@/components/CharmRunner";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { getIframeRecipe, type IFrameRecipe } from "@commontools/charm";
import { createComponent } from '@lit/react';
import { codeEditor } from "@commontools/os-ui";

const OsCodeEditor = createComponent(
  {
    tagName: "os-code-editor",
    elementClass: codeEditor.OsCodeEditor,
    react: React,
    events: {
      onDocChange: 'doc-change'
    }
  }
);

export default function CharmDetail() {
  const { charmManager } = useCharmManager();
  const { charmId } = useParams();
  const [currentFocus, setCurrentFocus] = React.useState<Charm | null>(null);
  const [details, setDetails] = React.useState(false);
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe | null>(null);
  const [workingSrc, setWorkingSrc] = React.useState<string | null>(null);
  
  React.useEffect(() => {
    async function loadCharm() {
      if (charmId) {
        await charmManager.init();
        const charm = (await charmManager.get(charmId)) ?? null;
        if (charm) {
          await charmManager.syncRecipe(charm);
          const ir = getIframeRecipe(charm);
          setIframeRecipe(ir?.iframe ?? null);
          console.log({ iframeRecipe: ir });
        }

        setCurrentFocus(charm);
      }
    }
    loadCharm();
  }, [charmId, charmManager]);

  if (!currentFocus) {
    return <div>Loading...</div>;
  }

  const saveChanges = () => {
    if (workingSrc && iframeRecipe) {
      saveNewRecipeVersion(charmManager, currentFocus, workingSrc, iframeRecipe.spec);
    }
  }

  const changes = workingSrc !== iframeRecipe?.src;

  return <><button onClick={() => setDetails(!details)}>details</button>
    {details ? <div>
      <p>charm id: {JSON.stringify(currentFocus, null, 2)}</p>
      <p>charm sourceCell id: {JSON.stringify(currentFocus.sourceCell, null, 2)}</p>
      <h3>Source</h3>
      {changes && <button onClick={saveChanges}>save changes</button>}
      <OsCodeEditor
        style={{ width: "100%", height: "600px" }}
        language="text/html"
        onDocChange={(e) => {
          setWorkingSrc(e.detail.state.doc.toString())
        }}
        source={getIframeRecipe(currentFocus).iframe?.src} />
    </div> :
      <CharmRenderer className="h-full" charm={currentFocus} />}
  </>;
}
