import { expect, setSystemTime, test } from "bun:test";
import app from "../src/index";
import { createHub, type HubCore } from "../src/hub";
import { createLocalDb, createLocalJournal } from "../src/sqlite";

export interface Step {
  method: "GET" | "PUT" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  now?: number;
}

export interface ApiExpect {
  status: number;
  body?: unknown;
  notContains?: string;
}

export interface ApiTest {
  setup?: Step[];
  request: Step;
  expect: ApiExpect;
}

type TestEnv = { HUB: { idFromName: (name: string) => string; get: () => HubCore } };

export function testEnv(): TestEnv {
  const core = createHub(createLocalDb(), createLocalJournal(), () => {});
  return { HUB: { idFromName: (name) => name, get: () => core } };
}

async function runStep(env: TestEnv, step: Step): Promise<Response> {
  if (step.now !== undefined) {
    setSystemTime(new Date(step.now * 1000));
  }
  const init: RequestInit = { method: step.method };
  if (step.body !== undefined) {
    init.headers = { "content-type": "application/json", ...step.headers };
    init.body = JSON.stringify(step.body);
  } else if (step.headers !== undefined) {
    init.headers = step.headers;
  }
  return app.request(step.path, init, env);
}

async function runApiTest(t: ApiTest) {
  const env = testEnv();
  try {
    for (const step of t.setup ?? []) {
      const res = await runStep(env, step);
      expect(res.status, `setup ${step.method} ${step.path}`).toBeLessThan(400);
    }

    const res = await runStep(env, t.request);
    expect(res.status).toBe(t.expect.status);
    const text = await res.text();
    if (t.expect.body !== undefined) {
      expect(JSON.parse(text)).toMatchObject(t.expect.body as object);
    }
    if (t.expect.notContains !== undefined) {
      expect(text).not.toContain(t.expect.notContains);
    }
  } finally {
    setSystemTime();
  }
}

export function apiTests(cases: Record<string, ApiTest>) {
  for (const [name, t] of Object.entries(cases)) {
    test(name, () => runApiTest(t));
  }
}
