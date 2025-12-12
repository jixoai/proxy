import { RouterProvider } from "@tanstack/react-router";
import { router } from "./routes";

export function ProxyViewer() {
  return <RouterProvider router={router} />;
}

export default ProxyViewer;
