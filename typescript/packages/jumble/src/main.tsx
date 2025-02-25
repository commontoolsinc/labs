import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import "@/styles/index.css";
import PhotoFlowIndex from "@/views/experiments/photoflow/Index.tsx";
import PhotoSetView from "@/views/experiments/photoflow/PhotoSetView.tsx";
import NewSpell from "@/views/experiments/photoflow/NewSpell.tsx";
import Shell from "@/views/Shell.tsx";
import { CharmsProvider } from "@/contexts/CharmsContext.tsx";
import "./recipes/index";
import { CharmsManagerProvider } from "@/contexts/CharmManagerContext.tsx";
import CharmList from "@/views/CharmList.tsx";
import CharmShowView from "@/views/CharmShowView.tsx";
import CharmDetailView from "@/views/CharmDetailView.tsx";
import { LanguageModelProvider } from "./contexts/LanguageModelContext.tsx";
import { BackgroundTaskProvider } from "./contexts/BackgroundTaskContext.tsx";
import { AuthenticationProvider } from "./contexts/AuthenticationContext.tsx";
import { setupIframe } from "./iframe-ctx.ts";
import GenerateJSONView from "@/views/utility/GenerateJSONView.tsx";
import SpellbookIndexView from "@/views/spellbook/SpellbookIndexView.tsx";
import SpellbookDetailView from "@/views/spellbook/SpellbookDetailView.tsx";
import SpellbookLaunchView from "./views/spellbook/SpellbookLaunchView.tsx";

setupIframe();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthenticationProvider>
      <CharmsProvider>
        <BackgroundTaskProvider>
          <LanguageModelProvider>
            <Router>
              <Routes>
                {/* Redirect root to common-knowledge */}
                <Route path="/" element={<Navigate to="/common-knowledge" replace />} />

                <Route
                  path="/:replicaName"
                  element={
                    <CharmsManagerProvider>
                      <Shell />
                    </CharmsManagerProvider>
                  }
                >
                  <Route index element={<CharmList />} />
                  <Route path=":charmId" element={<CharmShowView />} />
                  <Route path=":charmId/detail" element={<CharmDetailView />} />
                </Route>

                {/* Spellbook routes */}
                <Route path="/spellbook" element={<SpellbookIndexView />} />
                <Route path="/spellbook/:spellId" element={<SpellbookDetailView />} />
                <Route
                  path="/spellbook/launch/:spellId"
                  element={
                    <CharmsManagerProvider>
                      <SpellbookLaunchView />
                    </CharmsManagerProvider>
                  }
                />

                {/* internal tools / experimental routes */}
                <Route path="/utility/jsongen" element={<GenerateJSONView />} />

                {/* Photoflow routes preserved */}
                <Route path="/experiments/photoflow" element={<PhotoFlowIndex />} />
                <Route path="/experiments/photoflow/:photosetName" element={<PhotoSetView />} />
                <Route
                  path="/experiments/photoflow/:photosetName/spells/new"
                  element={<NewSpell />}
                />
              </Routes>
            </Router>
          </LanguageModelProvider>
        </BackgroundTaskProvider>
      </CharmsProvider>
    </AuthenticationProvider>
  </StrictMode>,
);
