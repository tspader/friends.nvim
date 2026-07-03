import app from "./src/index";
import { createLocalDb } from "./src/sqlite";

const port = Number(process.env.PORT ?? 8787);
const env = { DB: createLocalDb() };

Bun.serve({ port, fetch: (req) => app.fetch(req, env) });
console.log(`friends backend listening on http://127.0.0.1:${port} (in-memory db)`);
