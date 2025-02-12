import { saveNewRecipeVersion } from "@commontools/charm";
import React, { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { LoadingSpinner } from "@/components/Loader";
import { useCharm } from "@/hooks/use-charm";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";

function CharmEditView() {
  const { charmId } = useParams();
  const [workingSrc, setWorkingSrc] = React.useState<string | null>(null);
  const { currentFocus: charm, iframeRecipe } = useCharm(charmId);
  const { charmManager } = useCharmManager();

  const saveChanges = () => {
    if (workingSrc && iframeRecipe && charm) {
      saveNewRecipeVersion(charmManager, charm, workingSrc, iframeRecipe.spec);
    }
  };

  const hasUnsavedChanges = workingSrc !== iframeRecipe?.src;

  // As soon as the iframeRecipe is available, we want to set the workingSrc, for the code editor
  useEffect(() => {
    if (charm && iframeRecipe) {
      setWorkingSrc(iframeRecipe.src);
    }
  }, [iframeRecipe]);

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible={true} />
      </div>
    );
  }

  return (
    <div className="edit-view">
      <div className="editor">
        <CodeMirror
          value={workingSrc ?? ""}
          theme="dark"
          extensions={[javascript()]}
          onChange={(value) => setWorkingSrc(value)}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            indentOnInput: true,
          }}
        />
      </div>

      {/* NOTE(jake): These are potentially helpful context to have! */}
      {/* <table className="text-sm font-mono border-collapse">
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
                {JSON.stringify(charm?.sourceCell, null, 2)}
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
                  {JSON.stringify(charm?.sourceCell?.get(), null, 2)}
                </pre>
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-gray-600">charm get() id:</td>
              <td>
                <pre className="bg-gray-50 p-2 rounded">
                  {JSON.stringify(charm?.get(), null, 2)}
                </pre>
              </td>
            </tr>
          </tbody>
        </table>
      </details> */}
    </div>
  );
}

export default CharmEditView;
