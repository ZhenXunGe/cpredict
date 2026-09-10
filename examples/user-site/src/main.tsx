import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./site.css";
const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
const appRoot = import.meta.hot?.data.root ?? createRoot(root);
if (import.meta.hot) import.meta.hot.data.root = appRoot;
appRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
