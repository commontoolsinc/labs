import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
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
      <CharmsManagerProvider>
        <Router>
          <Routes>
            {/* bf: preserving these for now */}
            <Route path="/experiments/photoflow" element={<PhotoFlowIndex />} />
            <Route path="/experiments/photoflow/:photosetName" element={<PhotoSetView />} />
            <Route path="/experiments/photoflow/:photosetName/spells/new" element={<NewSpell />} />

            <Route path="/*" index element={<Shell />} />
          </Routes>
        </Router>
      </CharmsManagerProvider>
    </CharmsProvider>
  </StrictMode>,
);
