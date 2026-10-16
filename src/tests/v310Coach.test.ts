import { describe, expect, it } from "vitest";

import { analyseRide, formatRideForCoach, type RideSample } from "@/domain/rideAnalysis";

const START = Date.parse("2026-10-13T17:00:00Z");

// Builds 1 Hz samples from [seconds, watts, hr] segments.
function ride(segments: Array<[number, number, number]>, cadence = 92): RideSample[] {
  const samples: RideSample[] = [];
  let t = 0;
  for (const [seconds, watts, hr] of segments) {
    for (let s = 0; s < seconds; s += 1) {
      samples.push({ t: new Date(START + t * 1000), power: watts, hr, cadence });
      t += 1;
    }
  }
  return samples;
}

describe("ride analysis for the coach", () => {
  it("finds a 4×4 VO2 session and its interval watts", () => {
    const work: Array<[number, number, number]> = [[900, 180, 125]];
    for (const watts of [303, 302, 305, 298]) work.push([240, watts, 162], [270, 150, 130]);
    work.push([600, 170, 125]);
    const summary = analyseRide(ride(work), { ftp: 300 });
    expect(summary).not.toBeNull();
    expect(summary!.intervals.map((interval) => interval.watts)).toEqual([303, 302, 305, 298]);
    expect(summary!.intervals.every((interval) => Math.abs(interval.durationS - 240) <= 15)).toBe(
      true,
    );
    expect(summary!.best?.["240s"]).toBe(305);
    expect(summary!.np).toBeGreaterThan(summary!.avgW!);
    expect(summary!.if).toBeCloseTo(summary!.np! / 300, 2);
  });

  it("an even endurance ride has no intervals and almost no drift", () => {
    const summary = analyseRide(ride([[3600, 190, 133]]), { ftp: 300 });
    expect(summary!.intervals).toHaveLength(0);
    expect(summary!.np).toBe(190);
    expect(summary!.tss).toBe(40);
    expect(summary!.decouplingPct).toBe(0);
    expect(summary!.blocks10).toHaveLength(6);
  });

  it("measures heart-rate drift at the same watts", () => {
    const summary = analyseRide(
      ride([
        [1200, 180, 140],
        [1200, 180, 158],
      ]),
      { ftp: 300 },
    );
    expect(summary!.decouplingPct).toBeGreaterThan(8);
  });

  it("a watch file without power still reports time and heart rate", () => {
    const summary = analyseRide(
      ride([[1800, 0, 137]]).map((sample) => ({ ...sample, power: null, cadence: null })),
      { ftp: 300 },
    );
    expect(summary!.avgW).toBeNull();
    expect(summary!.hrAvg).toBe(137);
    expect(summary!.best).toBeNull();
  });

  it("the coach sees watts, intervals and the device's wrong FTP is kept apart", () => {
    const work: Array<[number, number, number]> = [[600, 180, 125]];
    for (const watts of [330, 320]) work.push([240, watts, 165], [240, 150, 130]);
    const summary = analyseRide(ride(work), { ftp: 300, device: "magene", deviceFtp: 222 });
    const line = formatRideForCoach(summary!, "вт 13.10 20:08");
    expect(line).toContain("вт 13.10 20:08");
    expect(line).toContain("NP");
    expect(line).toContain("#1");
    expect(line).toMatch(/#1 4мин 3[23]\dВт/);
    expect(summary!.deviceFtp).toBe(222);
    expect(summary!.ftp).toBe(300);
  });
});
