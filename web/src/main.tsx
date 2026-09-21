import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DecisionDialogProvider } from "./components/DecisionDialog";
import { initSession } from "./api";
import "./styles.css";

// Fetch the per-process mutation token before the first render, so every
// mutation control is live (or visibly explained) from the start. Failure is
// not fatal: the app still renders read-only, and mutations throw a clear
// session_not_initialized error until the page is reloaded.
initSession()
  .catch(() => {
    /* read-only mode — server unreachable or older backend without /api/session */
  })
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <DecisionDialogProvider>
          <App />
        </DecisionDialogProvider>
      </React.StrictMode>,
    );
  });
