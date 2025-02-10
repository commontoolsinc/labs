import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import "@/styles/index.css";
import PhotoFlowIndex from "@/views/experiments/photoflow/Index.tsx";
import PhotoSetView from "@/views/experiments/photoflow/PhotoSetView.tsx";
import NewSpell from "@/views/experiments/photoflow/NewSpell.tsx";
import Shell from "@/views/Shell.tsx";
import { CharmsProvider } from "@/contexts/CharmsContext";
import "./recipes/index";
import { CharmsManagerProvider } from "./contexts/CharmManagerContext";

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

          {/* New replica-based routes */}
          <Route
            path="/:replicaName/*"
            element={
              <CharmsManagerProvider>
                <Shell />
              </CharmsManagerProvider>
            }
          />
        </Routes>
      </Router>
    </CharmsProvider>
  </StrictMode>,
);
