import "@fontsource-variable/manrope";
import "@fontsource/unbounded/600.css";
import "./styles.css";
// first: it reads (and clears) the Mini App launch data from the address before routing
import "./telegram.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
