import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { I18nProvider } from "@/lib/i18n";
import { SettingsProvider } from "@/lib/settings";
import { TabStatusProvider } from "@/lib/tab-status";
import { ToastProvider } from "@/lib/toast";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <I18nProvider>
        <ToastProvider>
          <TabStatusProvider>
            <App />
          </TabStatusProvider>
        </ToastProvider>
      </I18nProvider>
    </SettingsProvider>
  </React.StrictMode>,
);
