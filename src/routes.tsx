import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ProxyViewerLayout } from "@/routes/ProxyViewerLayout";
import { RequestsPage } from "@/routes/RequestsPage";
import { ControlPage } from "@/routes/ControlPage";

export const rootRoute = createRootRoute({
  component: ProxyViewerLayout,
});

export const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RequestsPage,
});

export const controlRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/control",
  component: ControlPage,
});

export const routeTree = rootRoute.addChildren([requestsRoute, controlRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
