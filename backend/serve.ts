import app from "./src/index";
import { createHub } from "./src/hub";
import { createLocalDb, createLocalJournal } from "./src/sqlite";

const port = Number(process.env.PORT ?? 8787);
const flushMs = Number(process.env.FLUSH_MS ?? 10_000);

let scheduled = false;
const core = createHub(createLocalDb(), createLocalJournal(), () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    core.flush().catch((err) => console.error("flush failed:", err));
  }, flushMs);
});

const env = { HUB: { idFromName: (name: string) => name, get: () => core } };

Bun.serve({ port, fetch: (req) => app.fetch(req, env) });
console.log(`friends backend listening on http://127.0.0.1:${port} (in-memory db)`);
