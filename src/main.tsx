import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import SettingsWindow from "./Settings";

// Both windows load this same bundle; the label decides which one this is.
const isSettings = getCurrentWindow().label === "settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSettings ? <SettingsWindow /> : <App />}
  </React.StrictMode>,
);
