import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { z } from "zod";
import { ProxyViewerLayout } from "@/routes/ProxyViewerLayout";
import { RequestsPage } from "@/routes/RequestsPage";
import { ControlPage } from "@/routes/ControlPage";

const requestsSearchSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    dialog: z.enum(["json"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    filterMethod: z.string().optional(),
    filterStatus: z.string().optional(),
    filterUrl: z.string().optional(),
    filterRule: z.string().optional(),
  })
  .partial();

export const rootRoute = createRootRoute({
  component: ProxyViewerLayout,
});

export const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RequestsPage,
  validateSearch: (search) => requestsSearchSchema.parse(search),
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
