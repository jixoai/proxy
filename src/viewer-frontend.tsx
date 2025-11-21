/**
 * This file is the entry point for the Proxy Viewer React app
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProxyViewer } from "./ProxyViewer";
import "./index.css";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <ProxyViewer />
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
