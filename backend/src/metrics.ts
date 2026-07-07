// Additive, un-clamped counter metrics rankable on the leaderboard alongside
// active_time. active_time stays special-cased in hub.ts because it has its
// own wall-clock gap-clamping; every metric here is a plain running total.
export const COUNTER_METRICS = {
  keys_pressed: { max: 20000 },
} as const;

export type CounterMetric = keyof typeof COUNTER_METRICS;

export const COUNTER_METRIC_NAMES = Object.keys(COUNTER_METRICS) as CounterMetric[];
