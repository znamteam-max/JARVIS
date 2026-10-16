import { after, NextResponse } from "next/server";

import { runDueReminders } from "@/jobs/runDueReminders";
import { reviewNewWorkoutsIfDue } from "@/services/coachReviews";
import { backfillFoodPhotos } from "@/services/foodPhotos";
import { syncIntervalsIfDue } from "@/services/intervalsSync";
import { syncStravaIfDue } from "@/services/stravaSync";
import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { constantTimeEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The coach's workout review runs after the response and may take ~30 s.
export const maxDuration = 60;

export async function POST(request: Request) {
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  const actual = request.headers.get("authorization");
  if (!constantTimeEquals(actual, expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await runDueReminders();
  // Piggybacks on the scheduler tick; never lets a Strava problem fail reminders.
  const strava = await syncStravaIfDue().catch(() => ({ synced: false }));
  const intervals = await syncIntervalsIfDue().catch(() => ({ synced: false }));
  const foodPhotos = await backfillFoodPhotos().catch(() => ({ stored: 0 }));
  // New workouts get the coach's comment; the scheduler does not wait for the model.
  after(() =>
    reviewNewWorkoutsIfDue().catch((error) =>
      logger.warn("Coach review tick failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  return NextResponse.json({ ok: true, ...result, strava, intervals, foodPhotos });
}
