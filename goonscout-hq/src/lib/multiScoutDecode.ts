import type { ScoutingFieldMapping } from "@/lib/scoutingPayload";

type JsonObject = Record<string, unknown>;

export type ScoutType = "match" | "qualitative" | "pit";

type SlotCode = "b1" | "b2" | "b3" | "r1" | "r2" | "r3";

const SLOT_ORDER: SlotCode[] = ["b1", "b2", "b3", "r1", "r2", "r3"];

function asObject(value: unknown): JsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

function toNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return fallback;
}

function toTrimmedString(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number") {
		return String(value);
	}
	return "";
}

function getScoutTypeFromFt(ftValue: unknown): ScoutType | null {
	if (!Array.isArray(ftValue) || ftValue.length === 0) {
		return null;
	}

	const first = ftValue[0];
	const ftNumber = toNumber(first, NaN);
	if (!Number.isFinite(ftNumber)) {
		return null;
	}

	if (ftNumber === 1) {
		return "qualitative";
	}
	if (ftNumber === 2) {
		return "pit";
	}
	return "match";
}

export function detectScoutType(entry: unknown): ScoutType | null {
	const objectEntry = asObject(entry);
	if (!objectEntry) {
		return null;
	}

	const explicitType = toTrimmedString(objectEntry.scoutType).toLowerCase();
	if (explicitType === "match" || explicitType === "qualitative" || explicitType === "pit") {
		return explicitType;
	}

	return getScoutTypeFromFt(objectEntry.ft);
}

export function extractRawEntries(payload: unknown): JsonObject[] {
	if (Array.isArray(payload)) {
		return payload.map((item) => asObject(item)).filter((item): item is JsonObject => item !== null);
	}

	const objectPayload = asObject(payload);
	if (!objectPayload) {
		return [];
	}

	if (Array.isArray(objectPayload.data)) {
		return objectPayload.data.map((item) => asObject(item)).filter((item): item is JsonObject => item !== null);
	}

	return [objectPayload];
}

function parseQualitativeLabel(label: string): { field: string; slot: SlotCode | "general" | null } {
	const trimmed = label.trim();
	if (!trimmed) {
		return { field: "", slot: null };
	}

	const dashIndex = trimmed.lastIndexOf("-");
	if (dashIndex < 0) {
		return { field: trimmed, slot: null };
	}

	const field = trimmed.slice(0, dashIndex).trim();
	const slotToken = trimmed.slice(dashIndex + 1).trim().toLowerCase();

	if (slotToken === "general") {
		return { field: field || "general", slot: "general" };
	}

	if (SLOT_ORDER.includes(slotToken as SlotCode)) {
		return { field: field || slotToken, slot: slotToken as SlotCode };
	}

	return { field: trimmed, slot: null };
}

function normalizeTbaTeamKey(value: unknown): string {
	const text = toTrimmedString(value).toLowerCase();
	if (!text) {
		return "";
	}
	if (text.startsWith("frc")) {
		return text.slice(3);
	}
	return text;
}

function parseSlotTeamsFromEntryTeamField(value: unknown): Map<SlotCode, string> {
	const output = new Map<SlotCode, string>();
	const raw = toTrimmedString(value);
	if (!raw.includes(",")) {
		return output;
	}

	const parts = raw
		.split(",")
		.map((part) => normalizeTbaTeamKey(part))
		.filter((part) => part.length > 0);

	if (parts.length < SLOT_ORDER.length) {
		return output;
	}

	for (let index = 0; index < SLOT_ORDER.length; index += 1) {
		const team = parts[index] ?? "";
		if (team) {
			output.set(SLOT_ORDER[index], team);
		}
	}

	return output;
}

function extractAllianceTeamBySlot(matchResponse: unknown): Map<SlotCode, string> {
	const output = new Map<SlotCode, string>();
	const matchObject = asObject(matchResponse);
	const alliances = matchObject && asObject(matchObject.alliances);

	const blueTeams = alliances && asObject(alliances.blue) && Array.isArray((alliances.blue as JsonObject).team_keys)
		? ((alliances.blue as JsonObject).team_keys as unknown[])
		: [];
	const redTeams = alliances && asObject(alliances.red) && Array.isArray((alliances.red as JsonObject).team_keys)
		? ((alliances.red as JsonObject).team_keys as unknown[])
		: [];

	for (let index = 0; index < 3; index += 1) {
		const blue = normalizeTbaTeamKey(blueTeams[index]);
		const red = normalizeTbaTeamKey(redTeams[index]);

		output.set(SLOT_ORDER[index], blue);
		output.set(SLOT_ORDER[index + 3], red);
	}

	return output;
}

function buildMatchKeyCandidates(entry: JsonObject): string[] {
	const candidates = new Set<string>();

	const directMatchKeys = [entry.matchKey, entry.match_key, entry.match_key_raw, entry.tbaMatchKey, entry.key];
	for (const candidate of directMatchKeys) {
		const value = toTrimmedString(candidate);
		if (value.includes("_")) {
			candidates.add(value);
		}
	}

	const eventKey = toTrimmedString(entry.eventKey) || toTrimmedString(entry.event_key) || toTrimmedString(entry.event);
	const matchNumber = toNumber(entry.match, NaN);

	if (eventKey && Number.isFinite(matchNumber)) {
		const safeMatch = Math.max(0, Math.floor(matchNumber));
		candidates.add(`${eventKey}_qm${safeMatch}`);
		candidates.add(`${eventKey}_sf${safeMatch}`);
		candidates.add(`${eventKey}_qf${safeMatch}`);
		candidates.add(`${eventKey}_f${safeMatch}`);
	}

	return Array.from(candidates.values());
}

async function resolveQualitativeSlotTeams(
	entry: JsonObject,
	fetchMatchByKey: (matchKey: string) => Promise<unknown | null>,
): Promise<{ slotTeams: Map<SlotCode, string>; matchKey: string | null; eventKey: string | null }> {
	const candidates = buildMatchKeyCandidates(entry);

	for (const candidate of candidates) {
		try {
			const response = await fetchMatchByKey(candidate);
			if (!response) {
				continue;
			}

			const slotTeams = extractAllianceTeamBySlot(response);
			const hasAnyResolved = SLOT_ORDER.some((slot) => {
				const team = slotTeams.get(slot) ?? "";
				return team.length > 0;
			});

			if (!hasAnyResolved) {
				continue;
			}

			const eventKey = candidate.includes("_") ? candidate.split("_")[0] : null;
			return { slotTeams, matchKey: candidate, eventKey };
		} catch {
			continue;
		}
	}

	return { slotTeams: new Map<SlotCode, string>(), matchKey: null, eventKey: null };
}

export async function decodeQualitativeScoutingEntry(
	entry: JsonObject,
	fieldMapping: ScoutingFieldMapping,
	fetchMatchByKey: (matchKey: string) => Promise<unknown | null>,
): Promise<JsonObject[]> {
	const mapping = fieldMapping.mapping ?? {};
	const notesBySlot = new Map<SlotCode, Array<{ field: string; note: string }>>();
	const generalNotes: Array<{ field: string; note: string }> = [];

	for (const slot of SLOT_ORDER) {
		notesBySlot.set(slot, []);
	}

	for (const [id, fieldLabel] of Object.entries(mapping)) {
		const value = toTrimmedString(entry[id]);
		if (!value) {
			continue;
		}

		const parsedLabel = parseQualitativeLabel(fieldLabel);
		if (parsedLabel.slot === "general") {
			generalNotes.push({ field: parsedLabel.field || "general", note: value });
			continue;
		}

		if (parsedLabel.slot && SLOT_ORDER.includes(parsedLabel.slot)) {
			const bucket = notesBySlot.get(parsedLabel.slot) ?? [];
			bucket.push({ field: parsedLabel.field || parsedLabel.slot, note: value });
			notesBySlot.set(parsedLabel.slot, bucket);
			continue;
		}

		generalNotes.push({ field: parsedLabel.field || fieldLabel, note: value });
	}

	const directSlotTeams = parseSlotTeamsFromEntryTeamField(entry.team);
	const hasDirectSlotTeams = SLOT_ORDER.some((slot) => {
		const team = directSlotTeams.get(slot) ?? "";
		return team.length > 0;
	});

	const resolved = hasDirectSlotTeams ? { slotTeams: new Map<SlotCode, string>(), matchKey: null, eventKey: null } : await resolveQualitativeSlotTeams(entry, fetchMatchByKey);
	const matchNumber = toNumber(entry.match, 0);
	const scouter = toTrimmedString(entry.scouter) || "Unknown";
	const sourceTeam = hasDirectSlotTeams ? "" : toTrimmedString(entry.team);

	const output: JsonObject[] = [];

	for (const slot of SLOT_ORDER) {
		const notes = notesBySlot.get(slot) ?? [];
		if (notes.length === 0) {
			continue;
		}

		const directTeam = directSlotTeams.get(slot) ?? "";
		const resolvedTeam = resolved.slotTeams.get(slot) ?? "";
		const fallbackTeam = sourceTeam || slot;
		const team = directTeam || resolvedTeam || fallbackTeam;
		const alliance = slot.startsWith("b") ? "blue" : "red";

		output.push({
			match: matchNumber,
			team,
			scouter,
			slot,
			alliance,
			notes,
			generalNotes,
		});
	}

	if (output.length > 0) {
		return output;
	}

	return [
		{
			match: matchNumber,
			team: directSlotTeams.get("b1") || sourceTeam || "unknown",
			scouter,
			slot: "unknown",
			alliance: "unknown",
			notes: [],
			generalNotes,
		},
	];
}

function splitUnescaped(input: string, delimiter: string): string[] {
	const chunks: string[] = [];
	let current = "";
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (char === delimiter) {
			chunks.push(current);
			current = "";
			continue;
		}

		current += char;
	}

	if (escaping) {
		current += "\\";
	}

	chunks.push(current);
	return chunks;
}

function unescapePitText(value: string): string {
	let output = "";
	let escaping = false;

	for (const char of value) {
		if (escaping) {
			output += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		output += char;
	}

	if (escaping) {
		output += "\\";
	}

	return output;
}

function parsePitToken(token: string): { type: "text" | "slider" | "multi" | "single"; value: unknown } | null {
	const tokenType = token.slice(0, 2);
	const tokenValue = token.slice(2);

	if (tokenType === "t:") {
		return { type: "text", value: unescapePitText(tokenValue || "") };
	}

	if (tokenType === "s:") {
		return { type: "slider", value: toNumber(tokenValue, 0) };
	}

	if (tokenType === "m:") {
		const values = tokenValue.length
			? tokenValue
					.split(",")
					.map((part) => toNumber(part, NaN))
					.filter((part) => Number.isInteger(part) && part >= 0)
			: [];
		return { type: "multi", value: values };
	}

	if (tokenType === "o:") {
		return { type: "single", value: toNumber(tokenValue, -1) };
	}

	return null;
}

export function decodePitScoutingEntry(entry: JsonObject, _pitPayload: unknown): JsonObject {
	const pq = typeof entry.pq === "string" ? entry.pq : "";
	const answersByQuestion: Record<string, unknown> = {};

	for (const record of splitUnescaped(pq, ";").filter((item) => item.length > 0)) {
		const [questionPart, ...rest] = splitUnescaped(record, "=");
		const token = rest.join("=");

		const questionNumber = toNumber(questionPart, NaN);
		if (!Number.isInteger(questionNumber) || questionNumber <= 0 || token.length === 0) {
			continue;
		}

		const parsedToken = parsePitToken(token);
		if (!parsedToken) {
			continue;
		}

		answersByQuestion[String(questionNumber)] = parsedToken.value;
	}

	return {
		team: toTrimmedString(entry.team),
		scouter: toTrimmedString(entry.scouter) || "Unknown",
		answersByQuestion,
	};
}
