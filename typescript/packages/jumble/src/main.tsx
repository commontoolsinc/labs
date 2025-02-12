import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import "@/styles/index.css";
import PhotoFlowIndex from "@/views/experiments/photoflow/Index.tsx";
import PhotoSetView from "@/views/experiments/photoflow/PhotoSetView.tsx";
import NewSpell from "@/views/experiments/photoflow/NewSpell.tsx";
import Shell from "@/views/Shell";
import { CharmsProvider } from "@/contexts/CharmsContext";
import "./recipes/index";
import { CharmsManagerProvider } from "@/contexts/CharmManagerContext";
import CharmList from "@/views/CharmList";
import CharmDetail from "@/views/CharmDetail";
import CharmEditView from "@/views/CharmEditView";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CharmsProvider>
      <Router>
        <Routes>
          {/* Redirect root to common-knowledge */}
          <Route path="/" element={<Navigate to="/common-knowledge" replace />} />

          {/* Photoflow routes preserved */}
          <Route path="/experiments/photoflow" element={<PhotoFlowIndex />} />
          <Route path="/experiments/photoflow/:photosetName" element={<PhotoSetView />} />
          <Route path="/experiments/photoflow/:photosetName/spells/new" element={<NewSpell />} />

          <Route
            path="/:replicaName"
            element={
              <CharmsManagerProvider>
                <Shell />
              </CharmsManagerProvider>
            }
          >
            <Route index element={<CharmList />} />
            <Route path=":charmId" element={<CharmDetail />} />
            <Route path=":charmId/edit" element={<CharmEditView />} />
          </Route>
        </Routes>
      </Router>
    </CharmsProvider>
  </StrictMode>,
);
