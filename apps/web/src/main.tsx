import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // Ingestion polling is explicit; nothing should refetch behind the user's back.
    queries: { refetchOnWindowFocus: false, staleTime: 5_000 },
    mutations: { retry: false },
  },
});

const rootRoute = createRootRoute();
const studioRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });
const router = createRouter({ routeTree: rootRoute.addChildren([studioRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const container = document.getElementById("root");
if (container === null) throw new Error("#root element missing from index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
