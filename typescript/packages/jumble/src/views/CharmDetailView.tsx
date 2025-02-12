import { saveNewRecipeVersion, IFrameRecipe, Charm } from "@commontools/charm";
import React, { useEffect, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { LoadingSpinner } from "@/components/Loader";
import { useCharm } from "@/hooks/use-charm";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";

type Tab = "iterate" | "code" | "data";

interface IterationTabProps {
  charm: Charm;
}

const IterationTab: React.FC<IterationTabProps> = ({ charm }) => {
  return (
    <div className="iteration-tab">
      <h2 className="text-lg font-semibold mb-2">Iteration</h2>
      <div>this space intentionally left blank. More soon™️</div>
    </div>
  );
};

interface CodeTabProps {
  charm: Charm;
  iframeRecipe: IFrameRecipe | null;
}

const CodeTab: React.FC<CodeTabProps> = ({ charm, iframeRecipe }) => {
  const [workingSrc, setWorkingSrc] = useState<string | undefined>(undefined);
  const { charmManager } = useCharmManager();

  const saveChanges = () => {
    if (workingSrc && iframeRecipe && charm) {
      saveNewRecipeVersion(charmManager, charm, workingSrc, iframeRecipe.spec);
    }
  };

  const hasUnsavedChanges = workingSrc !== iframeRecipe?.src;

  // Set workingSrc once the iframeRecipe is available
  useEffect(() => {
    if (charm && iframeRecipe) {
      setWorkingSrc(iframeRecipe.src);
    }
  }, [iframeRecipe, charm]);

  return (
    <div className="editor-tab">
      <CodeMirror
        value={workingSrc}
        theme="dark"
        extensions={[javascript()]}
        onChange={(value) => setWorkingSrc(value)}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          indentOnInput: true,
        }}
      />
      <div className="mt-4">
        <button
          onClick={saveChanges}
          disabled={!hasUnsavedChanges}
          className="px-4 py-2 bg-green-500 text-white rounded disabled:opacity-50"
        >
          {hasUnsavedChanges ? "Save Changes" : "Saved"}
        </button>
      </div>
    </div>
  );
};

interface DataTabProps {
  charm: Charm;
}

const DataTab: React.FC<DataTabProps> = ({ charm }) => {
  return (
    <div className="view-tab">
      <h2 className="text-lg font-semibold mb-2">Charm Data</h2>
      <div className="mb-4">
        <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto">
          {JSON.stringify(charm, null, 2)}
        </pre>
      </div>
      {charm.sourceCell && (
        <div className="mb-4">
          <h3 className="text-md font-semibold mb-1">Source Cell Data</h3>
          <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto">
            {JSON.stringify(charm.sourceCell, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

// FIXME(jake): Eventually, we might move these tab views into their own components and use URL routes for deep linking.

function CharmEditView() {
  const { charmId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const validTabs: Tab[] = ["iterate", "code", "data"];
  // Set initial tab from hash (default to "code")
  const initialTab = location.hash.slice(1) as Tab;
  const [activeTab, setActiveTab] = useState<Tab>(
    validTabs.includes(initialTab) ? initialTab : "iterate",
  );

  // Update active tab if the hash changes (e.g., via back/forward navigation)
  useEffect(() => {
    const hashTab = location.hash.slice(1);
    if (validTabs.includes(hashTab as Tab) && hashTab !== activeTab) {
      setActiveTab(hashTab as Tab);
    }
  }, [location.hash]);

  // Update URL hash when activeTab changes
  useEffect(() => {
    if (location.hash.slice(1) !== activeTab) {
      navigate(`${location.pathname}#${activeTab}`, { replace: true });
    }
  }, [activeTab, location.pathname, location.hash, navigate]);

  const { currentFocus: charm, iframeRecipe } = useCharm(charmId);

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible={true} />
      </div>
    );
  }

  return (
    <div className="edit-view p-4">
      {/* Tab Navigation */}
      <div className="tabs mb-4 flex gap-2">
        <button
          onClick={() => setActiveTab("iterate")}
          className={`px-4 py-2 rounded ${
            activeTab === "iterate" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          Iteration
        </button>
        <button
          onClick={() => setActiveTab("code")}
          className={`px-4 py-2 rounded ${
            activeTab === "code" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          Edit Code
        </button>
        <button
          onClick={() => setActiveTab("data")}
          className={`px-4 py-2 rounded ${
            activeTab === "data" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          View Data
        </button>
      </div>

      {(() => {
        switch (activeTab) {
          case "iterate":
            return <IterationTab charm={charm} />;
          case "code":
            return <CodeTab charm={charm} iframeRecipe={iframeRecipe} />;
          case "data":
            return <DataTab charm={charm} />;
          default:
            return null;
        }
      })()}
    </div>
  );
}

export default CharmEditView;
