import { Charm, saveNewRecipeVersion } from "@commontools/charm";
import React from "react";
import { useParams } from "react-router-dom";
import { CharmRenderer } from "@/components/CharmRunner";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { getIframeRecipe, type IFrameRecipe } from "@commontools/charm";
import { createComponent } from "@lit/react";
import { codeEditor } from "@commontools/os-ui";
import { useSpring, animated } from "@react-spring/web";
import { LoadingSpinner } from "@/components/Loader";

const OsCodeEditor = createComponent({
  tagName: "os-code-editor",
  elementClass: codeEditor.OsCodeEditor,
  react: React,
  events: {
    onDocChange: "doc-change",
  },
});

const useCharm = (charmId: string | undefined) => {
  const { charmManager } = useCharmManager();
  const [currentFocus, setCurrentFocus] = React.useState<Charm | null>(null);
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe | null>(null);

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

  return {
    currentFocus,
    iframeRecipe,
  };
};

export default function CharmDetail() {
  const { charmId } = useParams();
  const [details, setDetails] = React.useState(false);
  const [workingSrc, setWorkingSrc] = React.useState<string | null>(null);
  const { currentFocus, iframeRecipe } = useCharm(charmId);
  const { charmManager } = useCharmManager();
  const [scrollProgress, setScrollProgress] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const calculateScrollProgress = () => {
      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight - container.clientHeight;
      const progress = scrollHeight > 0 ? scrollTop / scrollHeight : 0;
      setScrollProgress(progress);
    };

    calculateScrollProgress();
    container.addEventListener("scroll", calculateScrollProgress);

    if (details) {
      setScrollProgress(0);
      container.scrollTo(0, 0);
    }

    return () => {
      container.removeEventListener("scroll", calculateScrollProgress);
    };
  }, [details]);

  const charmSpring = useSpring({
    scale: details ? 0.45 : 1,
    borderRadius: details ? "16px" : "0px",
    opacity: details
      ? (() => {
          if (scrollProgress < 0.5) return 1;
          if (scrollProgress > 0.8) return 0;
          return 1 - (scrollProgress - 0.5) / 0.3;
        })()
      : 1,
    transform: details
      ? (() => {
          const baseScale = 1;
          if (scrollProgress < 0.5) return `scale(${baseScale})`;
          if (scrollProgress > 0.8) return `scale(0)`;
          return `scale(${baseScale * (1 - (scrollProgress - 0.5) / 0.3)})`;
        })()
      : "scale(1)",
    config: { tension: 400, friction: 38 },
  });

  const detailsSpring = useSpring({
    opacity: details ? 1 : 0,
    scale: details ? 1 : 0.95,
    filter: details ? "blur(0px)" : "blur(10px)",
    config: { tension: 400, friction: 38 },
  });

  const saveChanges = () => {
    if (workingSrc && iframeRecipe) {
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

          {/* Charm Renderer Container */}
          <animated.div
            style={{
              ...charmSpring,
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
            className="w-full max-w-screen-xl mx-auto"
          >
            <CharmRenderer className="w-full h-full" charm={currentFocus} />
          </animated.div>

          {/* Details Section */}
          <animated.div
            style={{
              ...detailsSpring,
              marginTop: details ? "-20rem" : 0,
            }}
            className="w-full max-w-screen-xl mx-auto p-8"
          >
            <div className="bg-white rounded-lg shadow-lg">
              <div className="p-6">
                <table className="text-sm font-mono border-collapse">
                  <tr>
                    <td className="pr-4 text-gray-600">charm id:</td>
                    <td>
                      <pre className="bg-gray-50 p-2 rounded">
                        {JSON.stringify(currentFocus, null, 2)}
                      </pre>
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-4 text-gray-600">charm sourceCell id:</td>
                    <td>
                      <pre className="bg-gray-50 p-2 rounded">
                        {JSON.stringify(currentFocus.sourceCell, null, 2)}
                      </pre>
                    </td>
                  </tr>
                </table>
                <h3>Source</h3>
                {changes && <button onClick={saveChanges}>save changes</button>}
                <OsCodeEditor
                  style={{ width: "100%", height: "600px" }}
                  language="text/html"
                  onDocChange={(e) => {
                    setWorkingSrc(e.detail.state.doc.toString());
                  }}
                  source={getIframeRecipe(currentFocus).iframe?.src}
                />
              </div>
            </div>
          </animated.div>
        </div>
      )}
    </div>
  );
}
