type TimedActivity = {
  startAt: Date;
  elapsedTimeS: number;
  movingTimeS: number;
  raw: unknown;
};

// Average power from Intervals.icu; only rides recorded by Zwift (or a power meter) have it.
export function activityWatts(activity: { raw: unknown }) {
  const raw = (activity.raw ?? {}) as Record<string, unknown>;
  const watts = Number(raw.icu_average_watts);
  return Number.isFinite(watts) && watts > 0 ? Math.round(watts) : null;
}

function span(activity: TimedActivity) {
  const start = activity.startAt.getTime();
  return [start, start + Math.max(activity.elapsedTimeS, activity.movingTimeS) * 1000] as const;
}

// The Garmin watch and Zwift both record the same indoor ride; only Zwift's copy has
// power. A record without power that is mostly covered by records with power is the
// watch's duplicate: counting it would double the calories and the training time.
export function withoutWatchDuplicates<T extends TimedActivity>(activities: T[]): T[] {
  const powered = activities.filter((activity) => activityWatts(activity) !== null);
  if (!powered.length) return activities;
  return activities.filter((activity) => {
    if (activityWatts(activity) !== null) return true;
    const [from, to] = span(activity);
    const length = to - from;
    if (length <= 0) return true;
    const covered = powered.reduce((sum, other) => {
      const [start, end] = span(other);
      return sum + Math.max(0, Math.min(end, to) - Math.max(start, from));
    }, 0);
    return covered < length * 0.5;
  });
}

// The phone notification: the review's opening without tables or Markdown marks.
export function coachNotificationExcerpt(markdown: string, maxChars = 700) {
  const text = markdown
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,4}\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${cut.slice(0, boundary > maxChars * 0.5 ? boundary + 1 : maxChars).trimEnd()}…`;
}
