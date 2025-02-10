import { Charm, saveNewRecipeVersion } from "@commontools/charm";
import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { CharmRenderer } from "@/components/CharmRunner";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { getIframeRecipe } from "@commontools/charm";
import { createComponent } from "@lit/react";
import { codeEditor } from "@commontools/os-ui";
import { animated } from "@react-spring/web";
import { LoadingSpinner } from "@/components/Loader";
import { useCharm } from "@/hooks/use-charm";
import { useCharmDetailAnimations } from "@/hooks/use-charm-detail-animation";

const OsCodeEditor = createComponent({
  tagName: "os-code-editor",
  elementClass: codeEditor.OsCodeEditor,
  react: React,
  events: {
    onDocChange: "doc-change",
  },
});

interface AnimatedCharmViewProps {
  spring: any;
  details: boolean;
  scrollProgress: number;
  charm: Charm;
}

function AnimatedCharmView({ spring, details, scrollProgress, charm }: AnimatedCharmViewProps) {
  return (
    <animated.div
      style={{
        ...spring,
        height: "100vh",
        position: details ? "sticky" : "relative",
        top: 0,
        transformOrigin: "top",
        overflow: "hidden",
        border: details ? "1.5px solid black" : "none",
        padding: 0,
        zIndex: 1,
        boxShadow: details ? "4px 4px 0px 0px rgba(0,0,0,0.5)" : "none",
        transition: "border 0.1s ease-in-out, box-shadow 0.1s ease-in-out",
        pointerEvents: details ? (scrollProgress > 0.5 ? "none" : "auto") : "auto",
      }}
      className="w-full mx-auto"
    >
      <CharmRenderer className="w-full h-full" charm={charm} />
    </animated.div>
  );
}

interface CharmDetailsProps {
  spring: any;
  charm: Charm;
  details: boolean;
  workingSrc: string | null;
  onSourceChange: (src: string) => void;
  onSaveChanges: () => void;
  changes: boolean;
}


function CharmDetails({
  spring,
  charm,
  details,
  onSourceChange,
  onSaveChanges,
  changes,
}: CharmDetailsProps) {
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();

  const deleteCharm = async () => {
    const result = await charmManager.remove(charm.entityId['/']);
    if (result) {
      navigate("/");
    }
  };

  return (
    <animated.div
      style={{
        ...spring,
        marginTop: details ? "-20rem" : 0,
      }}
      className="w-full mx-auto"
    >
      <div className="bg-white rounded-lg shadow-lg">
        <div className="p-6">
          <div>
            <button onClick={() => deleteCharm()}>delete charm</button>
            {changes && <button onClick={onSaveChanges}>save changes</button>}
          </div>
          <OsCodeEditor
            style={{ width: "100%", height: "600px" }}
            language="text/html"
            onDocChange={(e) => {
              onSourceChange((e as any).detail.state.doc.toString());
            }}
            source={getIframeRecipe(charm).iframe?.src}
          />
          <table className="text-sm font-mono border-collapse">
            <tbody>
              <tr>
                <td className="pr-4 text-gray-600">charm id:</td>
                <td>
                  <pre className="bg-gray-50 p-2 rounded">{JSON.stringify(charm, null, 2)}</pre>
                </td>
              </tr>
              <tr>
                <td className="pr-4 text-gray-600">charm sourceCell id:</td>
                <td>
                  <pre className="bg-gray-50 p-2 rounded">
                    {JSON.stringify(charm.sourceCell, null, 2)}
                  </pre>
                </td>
              </tr>
            </tbody>
          </table>
          <details>
            <table className="text-sm font-mono border-collapse">
              <tbody>
                <tr>
                  <td className="pr-4 text-gray-600">charm sourceCell id:</td>
                  <td>
                    <pre className="bg-gray-50 p-2 rounded">
                      {JSON.stringify(charm.sourceCell.get(), null, 2)}
                    </pre>
                  </td>
                </tr>
                <tr>
                  <td className="pr-4 text-gray-600">charm get() id:</td>
                  <td>
                    <pre className="bg-gray-50 p-2 rounded">
                      {JSON.stringify(charm.get(), null, 2)}
                    </pre>
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </div>
      </div>
    </animated.div>
  );
}

export default function CharmDetail() {
  const { charmId } = useParams();
  const [details, setDetails] = React.useState(false);
  const [workingSrc, setWorkingSrc] = React.useState<string | null>(null);
  const { currentFocus, iframeRecipe } = useCharm(charmId);
  const { charmManager } = useCharmManager();

  const { containerRef, scrollProgress, charmSpring, detailsSpring } =
    useCharmDetailAnimations(details);

  const saveChanges = () => {
    if (workingSrc && iframeRecipe && currentFocus) {
      saveNewRecipeVersion(charmManager, currentFocus, workingSrc, iframeRecipe.spec);
    }
  };

  const changes = workingSrc !== iframeRecipe?.src;

  return (
    <div className="h-full overflow-y-auto" ref={containerRef}>
      <LoadingSpinner visible={!currentFocus} />
      {currentFocus && (
        <div className="relative min-h-screen">
          <button className="fixed top-4 right-4 z-10" onClick={() => setDetails(!details)}>
            {details ? "hide details" : "show details"}
          </button>

          <AnimatedCharmView
            spring={charmSpring}
            details={details}
            scrollProgress={scrollProgress}
            charm={currentFocus}
          />

          {details && (
            <CharmDetails
              spring={detailsSpring}
              charm={currentFocus}
              details={details}
              workingSrc={workingSrc}
              onSourceChange={setWorkingSrc}
              onSaveChanges={saveChanges}
              changes={changes}
            />
          )}
        </div>
      )}
    </div>
  );
}
