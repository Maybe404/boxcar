import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { preview } from "./api";
import "./styles.css";
import { isWindows } from "./platform";

if (preview) document.documentElement.classList.add("preview");
// Fonts, keys and the title bar differ by platform.
document.documentElement.dataset.platform = isWindows ? "windows" : "mac";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
