import { AppearanceProvider, ToastProvider } from "@pluscosmic/ui";
import "@pluscosmic/ui/fonts.css";
import "@pluscosmic/ui/styles.css";
import "@xyflow/react/dist/style.css";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./app.css";

const root = document.getElementById("app");
if (root) {
  ReactDOM.createRoot(root).render(
    <StrictMode>
      <AppearanceProvider storageKey="windlass">
        <ToastProvider>
          <App />
        </ToastProvider>
      </AppearanceProvider>
    </StrictMode>,
  );
}
