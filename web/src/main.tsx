import React, { lazy, Suspense } from "react";
import { flushSync } from "react-dom";
import ReactDOM from "react-dom/client";
import { DecisionDialogProvider } from "./components/DecisionDialog";
import { initSession } from "./api";
import { isOrcaPluginFrame, isSidebarMode, watchOrcaWorkspace } from "./bridge/orcaBridge";
import { resetWorkspaceConfig } from "./harness";
import { useT } from "./i18n";
import "./styles/ide-workbench.css";

const App = lazy(() => import("./App"));
const SidebarApp = lazy(() => import("./components/SidebarApp"));

const root = ReactDOM.createRoot(document.getElementById("root")!);

function renderApp(sidebar: boolean) {
  root.render(
    <React.StrictMode>
      <DecisionDialogProvider>
        <Suspense fallback={null}>
          {sidebar ? <SidebarApp /> : <App />}
        </Suspense>
      </DecisionDialogProvider>
    </React.StrictMode>,
  );
}

function WorkspacePlaceholder({ waiting = false }: { waiting?: boolean }) {
  const t = useT();
  return <p className="dag-read-state" role="status">{t(waiting ? "read.loadingRuns" : "read.pickWorkspace")}</p>;
}

if (isOrcaPluginFrame()) {
  root.render(<WorkspacePlaceholder waiting />);
  watchOrcaWorkspace((workspaceId) => {
    // Clear the previous subtree (including portals and cached picker pages)
    // before the new workspace can issue requests or the browser can paint.
    flushSync(() => root.render(<WorkspacePlaceholder waiting={workspaceId !== null} />));
    resetWorkspaceConfig();
  }, () => renderApp(true));
} else {
  // Standalone mutations need the loopback token; reads still work if it fails.
  void initSession().catch(() => {}).finally(() => renderApp(isSidebarMode()));
}
