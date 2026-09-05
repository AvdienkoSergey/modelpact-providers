import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
// Not Vite's default, and not the engine repo's 5199 either: both repos get
// checked out side by side, and a suite that borrows whatever is on a port is
// a suite that passes against the wrong app.
const PORT = 5299;
const ORIGIN = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  // The demo, started for us. `--strictPort` makes a clash fail here rather
  // than move the app somewhere the specs do not look, and `--host` is not
  // optional: left to itself vite binds `localhost`, which can resolve to
  // `[::1]` and nothing else — a wait on 127.0.0.1 then times out against a
  // server that started fine.
  webServer: {
    command: `npm --prefix demo run dev -- --host ${HOST} --port ${PORT} --strictPort`,
    url: ORIGIN,
    // Blanked deliberately, and this is the line that keeps a test run free.
    // The `openai` entry points at a hosted API when the dev server has a key,
    // and a contributor with one exported in their shell should not discover
    // that by being billed for a suite that generates on it. The one gap is a
    // server already running with a key on this port, which `reuseExistingServer`
    // would then adopt.
    env: { OPENAI_API_KEY: "" },
    reuseExistingServer: !process.env["CI"],
    // `predev` builds `../dist` first, and a cold `@mlc-ai/web-llm` prebundle
    // is slow enough that Vite's default 60s is not always enough on a runner.
    timeout: 180_000,
  },
  use: { baseURL: ORIGIN },
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? "github" : "list",
  projects: [
    // Chromium only. Two of the three transports exist nowhere else — the
    // Prompt API ships in Chrome, and WebGPU is where it is usable — so a
    // second engine would test the assertions, not the target.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
