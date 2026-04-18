import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { SettingsProvider } from "@/lib/settings";
import { TabStatusProvider } from "@/lib/tab-status";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <TabStatusProvider>
        <App />
      </TabStatusProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
