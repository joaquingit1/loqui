/**
 * Renderer entry. Mounts the React app. The Build phase implements the home
 * screen + sidecar-status indicator + ping debug panel using window.loqui.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
