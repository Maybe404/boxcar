import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { preview } from "./api";
import "./styles.css";

if (preview) document.documentElement.classList.add("preview");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
