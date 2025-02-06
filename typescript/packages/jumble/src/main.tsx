import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "@/styles/index.css";
import Home from "@/views/Home.tsx";
import PhotoFlowIndex from "@/views/experiments/photoflow/Index.tsx";
import PhotoSetView from "@/views/experiments/photoflow/PhotoSetView.tsx";
import NewSpell from "@/views/experiments/photoflow/NewSpell.tsx";
import Shell from "@/views/Shell.tsx";
import CharmDetail from "@/views/CharmDetail";
import { CharmsProvider } from "@/contexts/CharmsContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CharmsProvider>
      <Router>
        <Routes>  
          <Route path="/*" element={<Shell />} />
        </Routes>
      </Router>
    </CharmsProvider>
  </StrictMode>,
);
