import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { onError } from "@commontools/runner";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import "./styles/index.css";
import Shell from "@/views/Shell.tsx";
import { CharmsProvider } from "@/contexts/CharmsContext.tsx";
import CharmList from "@/views/CharmList.tsx";
import CharmShowView from "@/views/CharmShowView.tsx";
import CharmDetailView from "@/views/CharmDetailView.tsx";
import { LanguageModelProvider } from "@/contexts/LanguageModelContext.tsx";
import { BackgroundTaskProvider } from "@/contexts/BackgroundTaskContext.tsx";
import { AuthenticationProvider } from "@/contexts/AuthenticationContext.tsx";
import { setupIframe } from "@/iframe-ctx.ts";
import GenerateJSONView from "@/views/utility/GenerateJSONView.tsx";
import SpellbookIndexView from "@/views/spellbook/SpellbookIndexView.tsx";
import SpellbookDetailView from "@/views/spellbook/SpellbookDetailView.tsx";
import StackedCharmsView from "@/views/StackedCharmsView.tsx";
import SpellbookLaunchView from "@/views/spellbook/SpellbookLaunchView.tsx";
import { ActionManagerProvider } from "@/contexts/ActionManagerContext.tsx";
import { ROUTES } from "@/routes.ts";

const ReplicaRedirect = () => {
  const savedReplica = localStorage.getItem("lastReplica");
  globalThis.location.href = savedReplica
    ? "/" + savedReplica
    : ROUTES.defaultReplica;
  return <div>redirecting...</div>;
};

setupIframe();

// Show an alert on the first error in a handler or lifted function.
let errorCount = 0;
onError((error) =>
  !errorCount++ &&
  globalThis.alert("Uncaught error in recipe: " + error.message)
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthenticationProvider>
      <CharmsProvider>
        <ActionManagerProvider>
          <BackgroundTaskProvider>
            <LanguageModelProvider>
              <Router>
                <Routes>
                  {/* Redirect root to saved replica or default */}
                  <Route
                    path={ROUTES.root}
                    element={<ReplicaRedirect />}
                  />

                  <Route
                    path={ROUTES.replicaRoot}
                    element={<Shell />}
                  >
                    <Route index element={<CharmList />} />
                    <Route
                      path={ROUTES.charmShow}
                      element={<CharmShowView />}
                    />
                    <Route
                      path={ROUTES.charmDetail}
                      element={<CharmDetailView />}
                    />
                    <Route
                      path={ROUTES.stackedCharms}
                      element={<StackedCharmsView />}
                    />
                  </Route>

                  {/* Spellbook routes */}
                  <Route
                    path={ROUTES.spellbookIndex}
                    element={<SpellbookIndexView />}
                  />
                  <Route
                    path={ROUTES.spellbookDetail}
                    element={<SpellbookDetailView />}
                  />
                  <Route
                    path={ROUTES.spellbookLaunch}
                    element={<SpellbookLaunchView />}
                  />

                  {/* internal tools / experimental routes */}
                  <Route
                    path={ROUTES.utilityJsonGen}
                    element={<GenerateJSONView />}
                  />
                </Routes>
              </Router>
            </LanguageModelProvider>
          </BackgroundTaskProvider>
        </ActionManagerProvider>
      </CharmsProvider>
    </AuthenticationProvider>
  </StrictMode>,
);
