import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyThemeMode, getThemeMode } from "../theme/theme-mode.js";
import { PopupApp } from "./PopupApp.js";

// Apply the saved Monokai theme (dark/light) before first paint to avoid a flash.
applyThemeMode(getThemeMode());

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
