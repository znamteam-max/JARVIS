// Power analysis of one ride (FIT from Magene/Zwift): what the coach needs and the
// Garmin watch never records. Pure, so the same numbers come out in tests and prod.

export type RideSample = {
  t: Date;
  power: number | null;
  hr: number | null;
  cadence: number | null;
};

export type RideInterval = {
  startMin: number;
  durationS: number;
  watts: number;
  hr: number | null;
  hrMax: number | null;
  cadence: number | null;
};

export type RideSummary = {
  startedAt: string;
  durationMin: number;
  movingMin: number;
  ftp: number;
  avgW: number | null;
  np: number | null;
  if: number | null;
  tss: number | null;
  kj: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  cadence: number | null;
  best: Record<string, number | null> | null;
  intervals: RideInterval[];
  blocks10: Array<{ fromMin: number; toMin: number; watts: number | null; hr: number | null }>;
  decouplingPct: number | null;
  device: string | null;
  deviceFtp: number | null;
};

const BEST_WINDOWS = [5, 60, 180, 240, 300, 1200];

type Second = { power: number | null; hr: number | null; cadence: number | null };

// One value per second, carried over short dropouts, empty over pauses longer than 5 s.
function perSecond(samples: RideSample[]): Second[] {
  const rows = [...samples].sort((a, b) => a.t.getTime() - b.t.getTime());
  if (!rows.length) return [];
  const start = rows[0].t.getTime();
  const total = Math.floor((rows[rows.length - 1].t.getTime() - start) / 1000) + 1;
  const out: Second[] = [];
  let index = 0;
  let last: RideSample | null = null;
  for (let s = 0; s < total; s += 1) {
    const now = start + s * 1000;
    while (index < rows.length && rows[index].t.getTime() <= now) {
      last = rows[index];
      index += 1;
    }
    const stale = !last || now - last.t.getTime() > 5000;
    out.push(
      stale || !last
        ? { power: null, hr: null, cadence: null }
        : { power: last.power, hr: last.hr, cadence: last.cadence },
    );
  }
  return out;
}

function rolling(values: number[], window: number) {
  const out: number[] = [];
  let acc = 0;
  values.forEach((value, i) => {
    acc += value;
    if (i >= window) acc -= values[i - window];
    out.push(acc / Math.min(i + 1, window));
  });
  return out;
}

function bestAverage(values: number[], window: number) {
  if (values.length < window) return null;
  let acc = values.slice(0, window).reduce((sum, value) => sum + value, 0);
  let top = acc;
  for (let i = window; i < values.length; i += 1) {
    acc += values[i] - values[i - window];
    top = Math.max(top, acc);
  }
  return Math.round(top / window);
}

function mean(values: Array<number | null>) {
  const present = values.filter((value): value is number => value !== null && value > 0);
  return present.length
    ? Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 10) / 10
    : null;
}

export function analyseRide(
  samples: RideSample[],
  options: { ftp: number; device?: string | null; deviceFtp?: number | null },
): RideSummary | null {
  const seconds = perSecond(samples);
  if (!seconds.length) return null;
  const ftp = options.ftp;
  const power = seconds.map((second) => second.power ?? 0);
  const hasPower = power.some((value) => value > 0);
  const r30 = rolling(power, 30);
  const np =
    hasPower && r30.length > 30
      ? Math.round(
          (r30.slice(29).reduce((sum, value) => sum + value ** 4, 0) / (r30.length - 29)) ** 0.25,
        )
      : null;

  // Work intervals: 30-s power above 85% FTP for at least 150 s (ends below 80%).
  const intervals: RideInterval[] = [];
  for (let i = 0; i < r30.length; i += 1) {
    if (r30[i] < 0.85 * ftp) continue;
    let j = i;
    while (j < r30.length && r30[j] >= 0.8 * ftp) j += 1;
    const from = Math.max(0, i - 15);
    const to = Math.max(i, j - 15);
    if (to - from >= 150) {
      const segment = seconds.slice(from, to);
      const hrs = segment.map((second) => second.hr).filter((hr): hr is number => Boolean(hr));
      intervals.push({
        startMin: Math.round((from / 60) * 10) / 10,
        durationS: to - from,
        watts: Math.round(mean(segment.map((second) => second.power)) ?? 0),
        hr: mean(segment.map((second) => second.hr)),
        hrMax: hrs.length ? Math.max(...hrs) : null,
        cadence: mean(segment.map((second) => second.cadence)),
      });
    }
    i = j;
  }

  const blocks10: RideSummary["blocks10"] = [];
  for (let k = 0; k < seconds.length - 300; k += 600) {
    const segment = seconds.slice(k, k + 600);
    blocks10.push({
      fromMin: Math.floor(k / 60),
      toMin: Math.floor((k + segment.length) / 60),
      watts: mean(segment.map((second) => second.power)),
      hr: mean(segment.map((second) => second.hr)),
    });
  }

  // Aerobic decoupling: watts per heartbeat, first half (after warm-up) vs second half.
  const efficiency = (segment: Second[]) => {
    const watts = mean(segment.map((second) => second.power));
    const hr = mean(segment.map((second) => second.hr));
    return watts && hr ? watts / hr : null;
  };
  const half = Math.floor(seconds.length / 2);
  const ef1 = efficiency(seconds.slice(300, half));
  const ef2 = efficiency(seconds.slice(half));
  const hrValues = seconds.map((second) => second.hr).filter((hr): hr is number => Boolean(hr));
  const moving = seconds.filter((second) => (second.power ?? 0) > 0 || (second.cadence ?? 0) > 0);
  const startedAt = [...samples].sort((a, b) => a.t.getTime() - b.t.getTime())[0].t;

  return {
    startedAt: startedAt.toISOString(),
    durationMin: Math.round((seconds.length / 60) * 10) / 10,
    movingMin: Math.round((moving.length / 60) * 10) / 10,
    ftp,
    avgW: hasPower ? Math.round(power.reduce((sum, value) => sum + value, 0) / power.length) : null,
    np,
    if: np ? Math.round((np / ftp) * 100) / 100 : null,
    tss: np ? Math.round(((seconds.length * np * (np / ftp)) / (ftp * 3600)) * 100) : null,
    kj: hasPower ? Math.round(power.reduce((sum, value) => sum + value, 0) / 1000) : null,
    hrAvg: mean(seconds.map((second) => second.hr)),
    hrMax: hrValues.length ? Math.max(...hrValues) : null,
    cadence: mean(seconds.map((second) => second.cadence)),
    best: hasPower
      ? Object.fromEntries(BEST_WINDOWS.map((w) => [`${w}s`, bestAverage(power, w)]))
      : null,
    intervals,
    blocks10,
    decouplingPct: ef1 && ef2 ? Math.round(((ef1 - ef2) / ef1) * 1000) / 10 : null,
    device: options.device ?? null,
    deviceFtp: options.deviceFtp ?? null,
  };
}

// One compact block per ride for the coach's context.
export function formatRideForCoach(summary: RideSummary, localLabel: string) {
  const head = [
    summary.durationMin - summary.movingMin > 2
      ? `${localLabel}: ${summary.durationMin} мин (в движении ${summary.movingMin})`
      : `${localLabel}: ${summary.durationMin} мин`,
    summary.avgW
      ? `avg ${summary.avgW} Вт, NP ${summary.np}, IF ${summary.if}, TSS ${summary.tss}`
      : null,
    summary.kj ? `${summary.kj} кДж` : null,
    summary.hrAvg ? `пульс ${summary.hrAvg}/${summary.hrMax}` : null,
    summary.cadence ? `каденс ${summary.cadence}` : null,
    summary.decouplingPct !== null ? `дрейф Pa:HR ${summary.decouplingPct}%` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const best = summary.best
    ? `  лучшие: ${Object.entries(summary.best)
        .filter(([, value]) => value)
        .map(([window, value]) => `${window} ${value}`)
        .join(", ")}`
    : null;
  const intervals = summary.intervals.length
    ? `  интервалы: ${summary.intervals
        .map(
          (interval, i) =>
            `#${i + 1} ${Math.round(interval.durationS / 6) / 10}мин ${interval.watts}Вт пульс ${interval.hr ?? "?"}/${interval.hrMax ?? "?"} каденс ${interval.cadence ?? "?"}`,
        )
        .join("; ")}`
    : null;
  const blocks =
    !summary.intervals.length && summary.blocks10.length
      ? `  по 10 мин (Вт/пульс): ${summary.blocks10
          .map((block) => `${block.watts ?? "-"}/${block.hr ?? "-"}`)
          .join(" → ")}`
      : null;
  return [head, best, intervals, blocks].filter(Boolean).join("\n");
}
