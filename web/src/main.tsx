import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { DecisionDialogProvider } from "./components/DecisionDialog";
import { initSession } from "./api";
import { isSidebarMode } from "./bridge/orcaBridge";
import "./styles/ide-workbench.css";

const App = lazy(() => import("./App"));
const SidebarApp = lazy(() => import("./components/SidebarApp"));

// Fetch the per-process mutation token before the first render, so every
// mutation control is live (or visibly explained) from the start. Failure is
// not fatal: the app still renders read-only, and mutations throw a clear
// session_not_initialized error until the page is reloaded.
initSession()
  .catch(() => {
    /* read-only mode — server unreachable or older backend without /api/session */
  })
  .finally(() => {
    const sidebar = isSidebarMode();
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <DecisionDialogProvider>
          <Suspense fallback={null}>
            {sidebar ? <SidebarApp /> : <App />}
          </Suspense>
        </DecisionDialogProvider>
      </React.StrictMode>,
    );
  });
