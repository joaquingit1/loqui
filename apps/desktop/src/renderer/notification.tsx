/**
 * Renderer entry for the standalone "Meeting Detected" popup window (a second
 * electron-vite HTML entry — see electron.vite.config.ts). Mounts only the
 * NotificationBanner; it shares the same preload (`window.loqui`) as the main
 * window but renders nothing else. styles.css first (design tokens + `.btn`),
 * then notification.css to make the body transparent + style the card.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotificationBanner } from "./notification/NotificationBanner.js";
import "./styles.css";
import "./notification/notification.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <NotificationBanner />
    </StrictMode>,
  );
}
