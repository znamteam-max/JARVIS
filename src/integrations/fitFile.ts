import { Decoder, Stream } from "@garmin/fitsdk";

import { analyseRide, type RideSample } from "@/domain/rideAnalysis";
import { UserFacingError } from "@/lib/errors";

type RecordMesg = {
  timestamp?: Date;
  power?: number;
  heartRate?: number;
  cadence?: number;
};

// Reads a FIT export (Magene, Zwift, MyWhoosh, Garmin) into the coach's ride summary.
export function parseFitRide(bytes: Uint8Array, options: { ftp: number }) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  if (!decoder.isFIT()) throw new UserFacingError("Это не FIT-файл тренировки.");
  const { messages } = decoder.read();
  const records = ((messages.recordMesgs ?? []) as RecordMesg[]).filter(
    (record) => record.timestamp instanceof Date,
  );
  if (!records.length) throw new UserFacingError("В файле нет записей тренировки.");
  const samples: RideSample[] = records.map((record) => ({
    t: record.timestamp as Date,
    power: typeof record.power === "number" ? record.power : null,
    hr: typeof record.heartRate === "number" ? record.heartRate : null,
    cadence: typeof record.cadence === "number" ? record.cadence : null,
  }));
  const session = (messages.sessionMesgs?.[0] ?? {}) as { thresholdPower?: number };
  const fileId = (messages.fileIdMesgs?.[0] ?? {}) as { manufacturer?: string | number };
  const summary = analyseRide(samples, {
    ftp: options.ftp,
    device: fileId.manufacturer !== undefined ? String(fileId.manufacturer) : null,
    deviceFtp: typeof session.thresholdPower === "number" ? session.thresholdPower : null,
  });
  if (!summary) throw new UserFacingError("Не получилось разобрать тренировку из файла.");
  return summary;
}
