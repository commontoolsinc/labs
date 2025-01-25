import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import "@/styles/index.css";
import Home from "@/views/Home.tsx";
import NewPhotoSet from "@/views/NewPhotoSet.tsx";
import PhotoSetView from "@/views/PhotoSetView.tsx";
import NewSpell from "@/views/NewSpell.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/data/new" element={<NewPhotoSet />} />
        <Route path="/data/:photosetName" element={<PhotoSetView />} />
        <Route path="/data/:photosetName/spells/new" element={<NewSpell />} />
      </Routes>
    </Router>
  </StrictMode>,
);
