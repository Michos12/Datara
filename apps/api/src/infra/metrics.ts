/**
 * A small in-process metrics registry in Prometheus text format (NFR-OBS): request latency by
 * route, job outcomes and durations. No dependency: a few counters and histograms are enough,
 * and they never carry organization or personal data as labels.
 */
const LATENCY_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5, 10];
const JOB_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300];

type Labels = Record<string, string>;

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; n: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = JSON.stringify(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, n: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]! += 1;
    });
    s.sum += value;
    s.n += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => {
        lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.n}`);
      lines.push(`${this.name}_sum${fmt(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${fmt(s.labels)} ${s.n}`);
    }
    return lines;
  }

  reset(): void {
    this.series.clear();
  }
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels, by = 1): void {
    const key = JSON.stringify(labels);
    const current = this.values.get(key);
    if (current) current.value += by;
    else this.values.set(key, { labels, value: by });
  }

  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values.values()].map((v) => `${this.name}${fmt(v.labels)} ${v.value}`),
    ];
  }

  reset(): void {
    this.values.clear();
  }
}

function fmt(labels: Labels): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return parts.length ? `{${parts.join(',')}}` : '';
}

export const httpDuration = new Histogram(
  'http_request_duration_seconds',
  'API request latency by method, route template and status class.',
  LATENCY_BUCKETS,
);
export const jobDuration = new Histogram(
  'job_duration_seconds',
  'Duration of successful Node background jobs by type.',
  JOB_BUCKETS,
);
export const jobsTotal = new Counter('jobs_total', 'Node background jobs by type and outcome.');

export function recordRequest(
  method: string,
  route: string,
  status: number,
  seconds: number,
): void {
  httpDuration.observe({ method, route, status: `${Math.floor(status / 100)}xx` }, seconds);
}

export function recordJob(type: string, outcome: 'succeeded' | 'failed', seconds: number): void {
  jobsTotal.inc({ type, outcome });
  if (outcome === 'succeeded') jobDuration.observe({ type }, seconds);
}

/** Gauges read at scrape time (queue depth, failed analytics runs), plus the registry. */
export function renderMetrics(gauges: { name: string; help: string; value: number }[]): string {
  const lines = [
    ...httpDuration.render(),
    ...jobDuration.render(),
    ...jobsTotal.render(),
    ...gauges.flatMap((g) => [
      `# HELP ${g.name} ${g.help}`,
      `# TYPE ${g.name} gauge`,
      `${g.name} ${g.value}`,
    ]),
  ];
  return `${lines.join('\n')}\n`;
}

export function resetMetrics(): void {
  httpDuration.reset();
  jobDuration.reset();
  jobsTotal.reset();
}
