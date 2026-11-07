import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntakeApp } from "./IntakeApp";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).has("legacy") ? <App /> : <IntakeApp />}
  </StrictMode>,
);
