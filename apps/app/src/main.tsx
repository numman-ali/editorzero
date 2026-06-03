import "./styles/index.css";

import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";

// Apply the persisted theme before React mounts. A tiny inline guard in
// index.html already does this pre-paint; this is the post-hydration source
// of truth and keeps the in-memory app aligned with the stored preference.
initTheme();

const router = createRouter({ routeTree });

// Register the router instance for type-safe routing (ADR 0028). The generated
// (gitignored) `routeTree.gen.ts` is the SSOT for route types; this module
// augmentation threads it through every `Link` / route hook, so a bad `to=` is
// a compile error rather than a runtime 404.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("#root element is missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
