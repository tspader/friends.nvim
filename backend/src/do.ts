import { DurableObject } from "cloudflare:workers";
import { createHub, FLUSH_INTERVAL_SECONDS, type HubCore } from "./hub";

type Env = { DB: D1Database };

export class Hub extends DurableObject<Env> {
  private core: HubCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = createHub(env.DB, ctx.storage.sql, async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_SECONDS * 1000);
      }
    });
  }

  register(input: Parameters<HubCore["register"]>[0]) {
    return this.core.register(input);
  }

  heartbeat(input: Parameters<HubCore["heartbeat"]>[0]) {
    return this.core.heartbeat(input);
  }

  deleteUser(input: Parameters<HubCore["deleteUser"]>[0]) {
    return this.core.deleteUser(input);
  }

  status(handles: string[]) {
    return this.core.status(handles);
  }

  leaderboard(query: Parameters<HubCore["leaderboard"]>[0]) {
    return this.core.leaderboard(query);
  }

  async alarm() {
    await this.core.flush();
  }
}
