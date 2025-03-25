import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { onError } from "@commontools/runner";
import {
  BrowserRouter as Router,
  createBrowserRouter,
  createRoutesFromChildren,
  matchRoutes,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import * as Sentry from "@sentry/react";
import { ErrorBoundary } from "@sentry/react";
import "./styles/index.css";
import Shell from "./views/Shell.tsx";
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

// Initialize Sentry
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_ENVIRONMENT || "development",
  release: import.meta.env.VITE_COMMIT_SHA || "development",
  tracesSampleRate: 1.0,
  integrations: [
    Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect,
      useLocation,
      useNavigationType,
      createRoutesFromChildren,
      matchRoutes,
    }),
  ],
});

const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

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
onError((error) => {
  !errorCount++ &&
    globalThis.alert("Uncaught error in recipe: " + error.message);
  // Also send to Sentry
  Sentry.captureException(error);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={<div>An error has occurred</div>}>
      <AuthenticationProvider>
        <CharmsProvider>
          <ActionManagerProvider>
            <BackgroundTaskProvider>
              <LanguageModelProvider>
                <Router>
                  <SentryRoutes>
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
                  </SentryRoutes>
                </Router>
              </LanguageModelProvider>
            </BackgroundTaskProvider>
          </ActionManagerProvider>
        </CharmsProvider>
      </AuthenticationProvider>
    </ErrorBoundary>
  </StrictMode>,
);
