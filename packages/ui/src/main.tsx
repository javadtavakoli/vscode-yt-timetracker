import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri } from "./api";
import "./styles.css";

async function bootstrap() {
  // Tauri: load and start the in-renderer host before React mounts so the
  // first `ready` command from <App/> finds a listener on the in-memory bus.
  if (isTauri()) {
    const { bootstrapDesktopHost } = await import("./desktopHost");
    await bootstrapDesktopHost();
  }

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Missing #root in index.html");
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void bootstrap();
