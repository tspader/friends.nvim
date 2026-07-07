export const COUNTER_METRICS = {
  keys_pressed: { max: 20000 },
} as const;

export type CounterMetric = keyof typeof COUNTER_METRICS;

export const COUNTER_METRIC_NAMES = Object.keys(COUNTER_METRICS) as CounterMetric[];
