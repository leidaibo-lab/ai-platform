import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntakeApp } from "./IntakeApp";
import "./intake.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IntakeApp />
  </StrictMode>,
);
