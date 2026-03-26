export type JsonEntry = Record<string, unknown>;

type JsonLikeObject = Record<string, unknown>;

export type ScoutingFieldMapping = {
  meta?: number[];
  text?: number[];
  mapping: Record<string, string>;
  success?: number[];
};

type ParsedEvent =
  | { time: number; value: number; result?: "success" | "fail" }
  | { time: number; duration: number };

const DEFAULT_FIELD_MAPPING: ScoutingFieldMapping = {
  meta: [16, 20],
  text: [17, 18, 19],
  mapping: {
    "0": "auto.fuel",
    "1": "teleop.fuel",
    "2": "auto.l1",
    "3": "teleop.l1",
    "4": "auto.l3",
    "5": "teleop.l3",
    "6": "auto.passing",
    "7": "teleop.passing",
    "8": "auto.defense",
    "9": "teleop.defense",
    "10": "auto.outpost",
    "11": "teleop.outpost",
    "12": "auto.depot",
    "13": "teleop.depot",
    "14": "auto.humanplayer",
    "15": "teleop.humanplayer",
    "16": "bricked",
    "17": "good",
    "18": "bad",
    "19": "area",
    "20": "slider",
  },
  success: [10, 11],
};

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toMaybeNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asObject(value: unknown): JsonLikeObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonLikeObject;
}

function splitModeMetric(tag: string): { mode: "auto" | "teleop"; metric: string } | null {
  if (tag.startsWith("auto.")) {
    return { mode: "auto", metric: tag.slice("auto.".length) };
  }
  if (tag.startsWith("teleop.")) {
    return { mode: "teleop", metric: tag.slice("teleop.".length) };
  }
  return null;
}

function isTimelineCompressedEntry(entry: JsonLikeObject): boolean {
  return typeof entry.t === "string" && typeof entry.s === "string" && Array.isArray(entry.b) && Array.isArray(entry.d);
}

function hasNumericIdKeys(entry: JsonLikeObject): boolean {
  return Object.keys(entry).some((key) => /^\d+$/.test(key) || /^\d+\.(s|f)$/.test(key));
}

function isFlatCompressedEntry(entry: JsonLikeObject): boolean {
  if (!hasNumericIdKeys(entry)) {
    return false;
  }
  return "match" in entry || "team" in entry || "scouter" in entry || "p" in entry || "ft" in entry;
}

function normalizeMetaValue(tag: string, raw: unknown): unknown {
  if (tag === "bricked") {
    if (typeof raw === "boolean") {
      return raw;
    }
    return toNum(raw, 0) !== 0;
  }

  if (tag === "slider") {
    return toNum(raw, 0);
  }

  return raw;
}

function decodeTimelineEntry(entry: JsonLikeObject, fieldMapping: ScoutingFieldMapping): JsonEntry {
  const idToTag = fieldMapping.mapping;
  const successIds = new Set((fieldMapping.success ?? []).map((value) => String(value)));

  const output: JsonEntry = {
    match: toNum(Array.isArray(entry.d) ? entry.d[0] : undefined, 0),
    team: String(Array.isArray(entry.d) ? (entry.d[1] ?? "") : ""),
    scouter: String(Array.isArray(entry.d) ? (entry.d[2] ?? "") : ""),
    auto: {},
    teleop: {},
  };

  if (Array.isArray(entry.p) && entry.p.length >= 2) {
    output.p = [toNum(entry.p[0], 0), toNum(entry.p[1], 0)];
  }

  if (Array.isArray(entry.ft)) {
    output.ft = entry.ft;
  }

  const textValues = typeof entry.s === "string" && entry.s.length > 0 ? entry.s.split("|") : [];
  (fieldMapping.text ?? []).forEach((id, index) => {
    const tag = idToTag[String(id)];
    if (!tag) {
      return;
    }
    output[tag] = textValues[index] ?? "";
  });

  (fieldMapping.meta ?? []).forEach((id, index) => {
    const tag = idToTag[String(id)];
    if (!tag) {
      return;
    }
    const raw = Array.isArray(entry.b) ? entry.b[index] : 0;
    output[tag] = normalizeMetaValue(tag, raw);
  });

  const grouped = new Map<string, ParsedEvent[]>();
  const timeline = String(entry.t ?? "").trim();

  if (timeline.length > 0) {
    for (const token of timeline.split(",")) {
      const parts = token.split(":");
      if (parts.length < 3 || parts.length > 4) {
        continue;
      }

      const [idPart, timePart, valuePart, resultPart] = parts;
      const tag = idToTag[idPart];
      if (!tag) {
        continue;
      }

      const split = splitModeMetric(tag);
      if (!split) {
        continue;
      }

      const timeSec = round2(toNum(timePart, 0) / 100);
      const rawValue = toNum(valuePart, 0);

      let event: ParsedEvent;
      if (split.metric === "defense") {
        event = { time: timeSec, duration: round2(rawValue / 100) };
      } else {
        const nextEvent: ParsedEvent = { time: timeSec, value: rawValue };
        if (parts.length === 4 && successIds.has(idPart)) {
          if (resultPart === "s") {
            nextEvent.result = "success";
          } else if (resultPart === "f") {
            nextEvent.result = "fail";
          }
        }
        event = nextEvent;
      }

      const key = `${split.mode}.${split.metric}`;
      const events = grouped.get(key) ?? [];
      events.push(event);
      grouped.set(key, events);
    }
  }

  for (const [key, events] of grouped.entries()) {
    const [mode, metric] = key.split(".") as ["auto" | "teleop", string];
    const modeBucket = output[mode] as JsonLikeObject;

    if (metric === "defense") {
      const totalTimeHeld = round2(
        events.reduce((sum, event) => {
          if ("duration" in event) {
            return sum + event.duration;
          }
          return sum;
        }, 0),
      );
      modeBucket[metric] = { totalTimeHeld, events };
      continue;
    }

    const total = events.reduce((sum, event) => {
      if ("value" in event) {
        return sum + event.value;
      }
      return sum;
    }, 0);

    const id = Object.keys(idToTag).find((candidate) => idToTag[candidate] === key);
    if (id && successIds.has(id)) {
      const successes = events.filter((event) => "result" in event && event.result === "success").length;
      const fails = events.filter((event) => "result" in event && event.result === "fail").length;
      const attempts = successes + fails;

      modeBucket[metric] = {
        total,
        attempts,
        successes,
        fails,
        accuracy: attempts > 0 ? round2(successes / attempts) : 0,
        events,
      };
      continue;
    }

    modeBucket[metric] = { total, events };
  }

  return output;
}

function decodeFlatCompressedEntry(entry: JsonLikeObject, fieldMapping: ScoutingFieldMapping): JsonEntry {
  const idToTag = fieldMapping.mapping;
  const successIds = new Set((fieldMapping.success ?? []).map((value) => String(value)));

  const output: JsonEntry = {
    match: toNum(entry.match, 0),
    team: String(entry.team ?? ""),
    scouter: String(entry.scouter ?? ""),
    auto: {},
    teleop: {},
  };

  if (Array.isArray(entry.p) && entry.p.length >= 2) {
    output.p = [toNum(entry.p[0], 0), toNum(entry.p[1], 0)];
  }

  if (Array.isArray(entry.ft)) {
    output.ft = entry.ft;
  }

  for (const [key, value] of Object.entries(entry)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }

    const tag = idToTag[key];
    if (!tag) {
      continue;
    }

    const split = splitModeMetric(tag);
    if (!split) {
      if (tag === "bricked") {
        output.bricked = typeof value === "boolean" ? value : toNum(value, 0) !== 0;
      } else if (tag === "slider") {
        output.slider = toNum(value, 0);
      } else {
        output[tag] = value;
      }
      continue;
    }

    const modeBucket = output[split.mode] as JsonLikeObject;
    const numericValue = toNum(value, 0);

    if (split.metric === "fuel") {
      modeBucket.fuel = numericValue;
      continue;
    }

    if (split.metric === "defense") {
      modeBucket.defenseTimeHeld = round2(numericValue / 100);
      continue;
    }

    modeBucket[split.metric] = { total: numericValue };
  }

  for (const [key, value] of Object.entries(entry)) {
    const match = key.match(/^(\d+)\.(s|f)$/);
    if (!match) {
      continue;
    }

    const id = match[1];
    const kind = match[2];

    if (!successIds.has(id)) {
      continue;
    }

    const tag = idToTag[id];
    if (!tag) {
      continue;
    }

    const split = splitModeMetric(tag);
    if (!split) {
      continue;
    }

    const modeBucket = output[split.mode] as JsonLikeObject;
    const current = asObject(modeBucket[split.metric]) ?? { total: toNum(entry[id], 0) };

    if (kind === "s") {
      current.successes = toNum(value, 0);
    }

    if (kind === "f") {
      current.fails = toNum(value, 0);
    }

    const successes = toNum(current.successes, 0);
    const fails = toNum(current.fails, 0);
    const attempts = successes + fails;

    current.total = toNum(current.total, toNum(entry[id], 0));
    current.attempts = attempts;
    current.accuracy = attempts > 0 ? round2(successes / attempts) : 0;

    modeBucket[split.metric] = current;
  }

  return output;
}

function normalizeCanonicalEntry(entry: JsonLikeObject): JsonEntry {
  const output: JsonEntry = { ...entry };

  if ("team" in output) {
    output.team = String(output.team ?? "");
  }

  if ("scouter" in output) {
    output.scouter = String(output.scouter ?? "");
  }

  if ("match" in output) {
    output.match = toNum(output.match, 0);
  }

  return output;
}

function isCanonicalNormalizedEntry(entry: JsonLikeObject): boolean {
  const hasTeam = typeof entry.team === "string" || typeof entry.team === "number";
  const hasMatch = typeof entry.match === "string" || typeof entry.match === "number";
  const hasScouter = typeof entry.scouter === "string" || typeof entry.scouter === "number";
  const hasAuto = Boolean(entry.auto && typeof entry.auto === "object" && !Array.isArray(entry.auto));
  const hasTeleop = Boolean(entry.teleop && typeof entry.teleop === "object" && !Array.isArray(entry.teleop));

  return hasTeam && hasMatch && hasScouter && hasAuto && hasTeleop;
}

export function normalizeScoutingEntry(
  entry: unknown,
  options?: {
    fieldMapping?: ScoutingFieldMapping;
    compressedOnly?: boolean;
    requireFieldMapping?: boolean;
  },
): JsonEntry | null {
  const objectEntry = asObject(entry);
  if (!objectEntry) {
    return null;
  }

  const compressedOnly = options?.compressedOnly ?? true;
  const requireFieldMapping = options?.requireFieldMapping ?? true;
  const fieldMapping = options?.fieldMapping ?? (requireFieldMapping ? undefined : DEFAULT_FIELD_MAPPING);

  if (!fieldMapping || !fieldMapping.mapping || Object.keys(fieldMapping.mapping).length === 0) {
    return null;
  }

  if (isTimelineCompressedEntry(objectEntry)) {
    return decodeTimelineEntry(objectEntry, fieldMapping);
  }

  if (isFlatCompressedEntry(objectEntry)) {
    return decodeFlatCompressedEntry(objectEntry, fieldMapping);
  }

  if (isCanonicalNormalizedEntry(objectEntry)) {
    return normalizeCanonicalEntry(objectEntry);
  }

  if (compressedOnly) {
    return null;
  }

  return normalizeCanonicalEntry(objectEntry);
}

export function normalizeScoutingDataset(
  payload: unknown,
  options?: {
    fieldMapping?: ScoutingFieldMapping;
    compressedOnly?: boolean;
    requireFieldMapping?: boolean;
  },
): JsonEntry[] {
  const source = asObject(payload);

  const rawEntries = Array.isArray(payload)
    ? payload
    : source && Array.isArray(source.data)
      ? source.data
      : source
        ? [source]
        : [];

  return rawEntries
    .map((entry) => normalizeScoutingEntry(entry, options))
    .filter((entry): entry is JsonEntry => entry !== null);
}

export function extractEntryNumericMetrics(entry: JsonEntry): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const [key, value] of Object.entries(entry)) {
    const numericValue = toMaybeNum(value);
    if (numericValue !== null) {
      metrics[key] = numericValue;
      continue;
    }

    if ((key === "auto" || key === "teleop") && value && typeof value === "object" && !Array.isArray(value)) {
      const phaseBucket = value as JsonLikeObject;

      for (const [metric, metricValue] of Object.entries(phaseBucket)) {
        const tag = `${key}.${metric}`;
        const metricNumeric = toMaybeNum(metricValue);

        if (metricNumeric !== null) {
          metrics[tag] = metricNumeric;
          continue;
        }

        const metricObject = asObject(metricValue);
        if (!metricObject) {
          continue;
        }

        const total = toMaybeNum(metricObject.total);
        const totalTimeHeld = toMaybeNum(metricObject.totalTimeHeld);
        const defenseTimeHeld = toMaybeNum(metricObject.defenseTimeHeld);

        if (total !== null) {
          metrics[tag] = total;
        } else if (totalTimeHeld !== null) {
          metrics[tag] = totalTimeHeld;
        } else if (defenseTimeHeld !== null) {
          metrics[tag] = defenseTimeHeld;
        }

        const attempts = toMaybeNum(metricObject.attempts);
        const successes = toMaybeNum(metricObject.successes);
        const fails = toMaybeNum(metricObject.fails);
        const accuracy = toMaybeNum(metricObject.accuracy);

        if (attempts !== null) {
          metrics[`${tag}.attempts`] = attempts;
        }
        if (successes !== null) {
          metrics[`${tag}.successes`] = successes;
        }
        if (fails !== null) {
          metrics[`${tag}.fails`] = fails;
        }
        if (accuracy !== null) {
          metrics[`${tag}.accuracy`] = accuracy;
        }
      }
    }
  }

  return metrics;
}
