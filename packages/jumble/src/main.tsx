import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleMethod, Runtime } from "@commontools/runner";
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
import { AuthenticationProvider } from "@/contexts/AuthenticationContext.tsx";
import { setupIframe } from "@/iframe-ctx.ts";
import GenerateJSONView from "@/views/utility/GenerateJSONView.tsx";
import SpellbookIndexView from "@/views/spellbook/SpellbookIndexView.tsx";
import SpellbookDetailView from "@/views/spellbook/SpellbookDetailView.tsx";
import StackedCharmsView from "@/views/StackedCharmsView.tsx";
import SpellbookLaunchView from "@/views/spellbook/SpellbookLaunchView.tsx";
import FullscreenInspectorView from "@/views/FullscreenInspectorView.tsx";
import { ActionManagerProvider } from "@/contexts/ActionManagerContext.tsx";
import { ActivityProvider } from "@/contexts/ActivityContext.tsx";
import { RuntimeProvider } from "@/contexts/RuntimeContext.tsx";
import { ROUTES } from "@/routes.ts";

// Determine environment based on hostname
const determineEnvironment = () => {
  const hostname = globalThis.location.hostname;

  // Map hostnames to environments
  if (hostname.startsWith("estuary")) {
    return {
      environment: "production",
      dsn:
        "https://09abf88225ffaad4bca353395ed943f5@o4508230766100480.ingest.us.sentry.io/4509062092423168",
    };
  } else if (hostname.startsWith("toolshed")) {
    return {
      environment: "staging",
      dsn:
        "https://839a9ee7738bb34a87fc8c73edc61c26@o4508230766100480.ingest.us.sentry.io/4509012183875584",
    };
  }
  return null;
};

// Get environment config
const envConfig = determineEnvironment();

if (envConfig) {
  // Initialize Sentry
  Sentry.init({
    dsn: envConfig.dsn,
    environment: envConfig.environment,
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
}

const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

const ReplicaRedirect = () => {
  const savedReplica = localStorage.getItem("lastReplica");
  globalThis.location.href = savedReplica
    ? "/" + savedReplica
    : ROUTES.defaultReplica;
  return <div>redirecting...</div>;
};

// Create runtime with error and console handlers
let errorCount = 0;
const runtime = new Runtime({
  storageUrl: location.origin,
  errorHandlers: [(error) => {
    !errorCount++ &&
      globalThis.alert(
        "Uncaught error in recipe: " + error.message + "\n" + error.stack,
      );
    // Also send to Sentry
    Sentry.captureException(error);
  }],
  consoleHandler: (metadata, method, args) => {
    // Handle console messages depending on charm context.
    // This is essentially the same as the default handling currently,
    // but adding this here for future use.
    if (metadata?.charmId) {
      return [`Charm(${metadata.charmId}) [${method}]:`, ...args];
    }
    return [`Console [${method}]:`, ...args];
  },
});

setupIframe(runtime);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={<div>An error has occurred</div>}>
      <RuntimeProvider runtime={runtime}>
        <AuthenticationProvider>
          <CharmsProvider>
            <ActionManagerProvider>
              <ActivityProvider>
                <Router>
                  <SentryRoutes>
                    {/* Redirect root to saved replica or default */}
                    <Route
                      path={ROUTES.root}
                      element={<ReplicaRedirect />}
                    />
                    <Route
                      path={ROUTES.inspector}
                      element={<FullscreenInspectorView />}
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
              </ActivityProvider>
            </ActionManagerProvider>
          </CharmsProvider>
        </AuthenticationProvider>
      </RuntimeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
