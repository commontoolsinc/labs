import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "@/styles/index.css";
import Home from "@/views/Home.tsx";
import PhotoFlowIndex from "@/views/experiments/photoflow/Index.tsx";
import PhotoSetView from "@/views/experiments/photoflow/PhotoSetView.tsx";
import NewSpell from "@/views/experiments/photoflow/NewSpell.tsx";
import Shell from "@/views/Shell.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <Routes>f
        <Route path="/" element={<Home />} />

        <Route path="/shell" element={<Shell />} />

        <Route path="/experiments/photoflow" element={<PhotoFlowIndex />} />
        <Route path="/experiments/photoflow/:photosetName" element={<PhotoSetView />} />
        <Route path="/experiments/photoflow/:photosetName/spells/new" element={<NewSpell />} />
      </Routes>
    </Router>
  </StrictMode>,
);
