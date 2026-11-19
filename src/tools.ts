// The tools Claude can use:
//   add_medication     save a new medicine
//   list_medications   find medicines (and their ids)
//   update_medication  fix a mistake in a saved medicine
//   stop_medication    mark a medicine as stopped (never deletes it)
//   get_schedule       what to take on a given day, sorted by time
//
// Each tool has two halves:
//   1. A definition (name + description + JSON schema) that we SEND to Claude,
//      so it knows the tool exists and what to fill in.
//   2. A function that RUNS on your computer when Claude asks to use it.

import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadMedications, loadSettings, saveMedications, type Medication } from "./storage.js";

// ===========================================================================
// 1. The definitions sent to Claude
// ===========================================================================
// strict: true means Claude's input is guaranteed to match the schema.
// Strict mode rules:
//   - every object needs additionalProperties: false
//   - fields not listed in "required" are optional (max 24 optional fields
//     across all strict tools in one request)
//   - fields that allow null ("type": [..., "null"]) count as union types
//     (max 16 across all strict tools in one request)
//   - number limits like minimum/maximum are NOT supported, so "1-24" is
//     written in the description and checked by zod below instead.

// The medicine fields, written once and shared by add_medication (all
// required) and update_medication (all optional).
const medicationFieldSchemas = {
  name: { type: "string", description: "Medication name, e.g. \"Brufen\"" },
  dose: { type: "string", description: "Dose exactly as prescribed, e.g. \"400 mg\"" },
  timing_type: {
    type: "string",
    enum: ["times_of_day", "every_x_hours", "when_needed"],
  },
  times_of_day: {
    type: ["array", "null"],
    items: { type: "string", enum: ["morning", "lunch", "evening", "bedtime"] },
    description: "Use when timing_type is times_of_day, otherwise null",
  },
  every_hours: {
    type: ["integer", "null"],
    description: "1 to 24. Use when timing_type is every_x_hours, otherwise null",
  },
  first_dose_time: {
    type: ["string", "null"],
    description:
      "HH:MM (24-hour) of the first dose on start_date. Use when timing_type is " +
      "every_x_hours; null if not known yet, or if timing_type is something else",
  },
  with_food: {
    type: "string",
    enum: ["with_food", "without_food", "not_specified"],
    description: "Only what the doctor or leaflet said. If nothing was said, not_specified",
  },
  start_date: { type: "string", format: "date", description: "YYYY-MM-DD" },
  duration_days: {
    type: ["integer", "null"],
    description: "Number of days to take it, or null if ongoing",
  },
  reason: { type: ["string", "null"], description: "What it is for, or null if unknown" },
} as const;

export const addMedicationTool: Anthropic.Tool = {
  name: "add_medication",
  description:
    "Save a NEW medication to the user's list. Only call this when the name, dose, " +
    "timing and start date are all known, and the user has confirmed the summary. " +
    "Never guess a dose: if the user did not say it, ask them instead of calling this tool.",
  strict: true,
  input_schema: {
    type: "object",
    properties: medicationFieldSchemas,
    required: Object.keys(medicationFieldSchemas),
    additionalProperties: false,
  },
};

export const listMedicationsTool: Anthropic.Tool = {
  name: "list_medications",
  description:
    "List the user's saved medications with their ids. Call this to find the id of " +
    "the medicine the user means before updating or stopping it.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["current", "stopped", "all"],
        description: "Which medicines to list. Defaults to current.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const updateMedicationTool: Anthropic.Tool = {
  name: "update_medication",
  description:
    "Fix a mistake in a saved medication. Send the id and ONLY the fields that change. " +
    "A field left out stays as it is; a field set to null is cleared. " +
    "Get the id from list_medications. Never guess a dose.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id from list_medications" },
      ...medicationFieldSchemas,
    },
    required: ["id"],
    additionalProperties: false,
  },
};

export const stopMedicationTool: Anthropic.Tool = {
  name: "stop_medication",
  description:
    "Mark a medication as stopped. It stays in the history; nothing is deleted. " +
    "Only call this when you know the date it was stopped and the reason. " +
    "Get the id from list_medications.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id from list_medications" },
      stop_date: { type: "string", format: "date", description: "YYYY-MM-DD" },
      stop_reason: { type: "string", description: "Why it was stopped, in the user's words" },
    },
    required: ["id", "stop_date", "stop_reason"],
    additionalProperties: false,
  },
};

export const getScheduleTool: Anthropic.Tool = {
  name: "get_schedule",
  description:
    "Get what the user takes on one day: doses sorted by clock time, medicines taken " +
    "only if needed, and every_x_hours medicines whose first dose time is unknown. " +
    "Only current medicines active on that day are included. Use this for any " +
    "question about when to take something.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", format: "date", description: "YYYY-MM-DD" },
    },
    required: ["date"],
    additionalProperties: false,
  },
};

// index.ts sends this whole list to Claude on every request.
export const tools: Anthropic.Tool[] = [
  addMedicationTool,
  listMedicationsTool,
  updateMedicationTool,
  stopMedicationTool,
  getScheduleTool,
];

// ===========================================================================
// 2. A second check in our own code (zod)
// ===========================================================================
// Strict mode checks the shape. Zod also checks the rules strict mode can't.

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/; // "00:00" to "23:59"

const MedicationFields = z.object({
  name: z.string().min(1),
  dose: z.string().min(1),
  timing_type: z.enum(["times_of_day", "every_x_hours", "when_needed"]),
  times_of_day: z.array(z.enum(["morning", "lunch", "evening", "bedtime"])).nullable(),
  every_hours: z.int().min(1).max(24).nullable(),
  first_dose_time: z.string().regex(HH_MM, "must be HH:MM, e.g. \"09:00\"").nullable(),
  with_food: z.enum(["with_food", "without_food", "not_specified"]),
  start_date: z.iso.date(),
  duration_days: z.int().min(1).nullable(),
  reason: z.string().nullable(),
});

// The timing fields must match timing_type. Used for new AND updated medicines,
// so a correction can't leave a medicine half one way, half the other.
const CheckedMedicationFields = MedicationFields
  .refine((m) => m.timing_type !== "times_of_day" || (m.times_of_day?.length ?? 0) > 0, {
    message: "times_of_day is required when timing_type is times_of_day",
  })
  .refine((m) => m.timing_type === "times_of_day" || m.times_of_day === null, {
    message: "times_of_day must be null unless timing_type is times_of_day",
  })
  .refine((m) => m.timing_type !== "every_x_hours" || m.every_hours !== null, {
    message: "every_hours is required when timing_type is every_x_hours",
  })
  .refine((m) => m.timing_type === "every_x_hours" || m.every_hours === null, {
    message: "every_hours must be null unless timing_type is every_x_hours",
  })
  .refine((m) => m.timing_type === "every_x_hours" || m.first_dose_time === null, {
    message: "first_dose_time must be null unless timing_type is every_x_hours",
  });

const ListInput = z.object({
  status: z.enum(["current", "stopped", "all"]).optional(),
});

// .partial() makes every field optional: Claude sends only what changes.
const UpdateInput = MedicationFields.partial().extend({ id: z.string() });

const ScheduleInput = z.object({ date: z.iso.date() });

const StopInput = z.object({
  id: z.string(),
  stop_date: z.iso.date(),
  stop_reason: z.string().min(1),
});

// ===========================================================================
// 3. The functions that run when Claude calls a tool
// ===========================================================================

// end_date = the LAST day you take it. "4 days starting 17 Nov" means the
// 17th, 18th, 19th and 20th, so we add (duration_days - 1).
function calculateEndDate(startDate: string, durationDays: number | null): string | null {
  if (durationDays === null) return null; // ongoing
  const date = new Date(`${startDate}T00:00:00Z`); // UTC avoids daylight-saving surprises
  date.setUTCDate(date.getUTCDate() + durationDays - 1);
  return date.toISOString().slice(0, 10);
}

// Finds a medicine by id, or throws an error Claude can act on.
function findById(all: Medication[], id: string): Medication {
  const medication = all.find((m) => m.id === id);
  if (!medication) {
    throw new Error(`No medication with id "${id}". Call list_medications to get the right id.`);
  }
  return medication;
}

async function addMedication(input: unknown): Promise<Medication> {
  const parsed = CheckedMedicationFields.parse(input); // throws if something is wrong
  const medication: Medication = {
    id: randomUUID(),
    status: "current",
    ...parsed,
    end_date: calculateEndDate(parsed.start_date, parsed.duration_days),
  };
  const all = await loadMedications();
  all.push(medication);
  await saveMedications(all);
  return medication;
}

async function listMedications(input: unknown): Promise<Medication[]> {
  const { status = "current" } = ListInput.parse(input);
  const all = await loadMedications();
  return status === "all" ? all : all.filter((m) => m.status === status);
}

async function updateMedication(input: unknown): Promise<Medication> {
  const { id, ...changes } = UpdateInput.parse(input);
  const all = await loadMedications();
  const existing = findById(all, id);

  // Put the changes on top of the saved entry, then check the WHOLE result
  // with the same rules as add_medication. (Zod keeps only the medicine
  // fields here, so id/status/stop info can't be changed by this tool.)
  // (first_dose_time: null first, for entries saved before Step 5 that don't have it.)
  const merged = CheckedMedicationFields.parse({ first_dose_time: null, ...existing, ...changes });

  const updated: Medication = { ...existing, ...merged };
  if ("start_date" in changes || "duration_days" in changes) {
    updated.end_date = calculateEndDate(updated.start_date, updated.duration_days);
  }

  all[all.indexOf(existing)] = updated;
  await saveMedications(all);
  return updated;
}

async function stopMedication(input: unknown): Promise<Medication> {
  const { id, stop_date, stop_reason } = StopInput.parse(input);
  const all = await loadMedications();
  const existing = findById(all, id);

  if (existing.status === "stopped") {
    throw new Error(`${existing.name} was already stopped on ${existing.stop_date}.`);
  }
  // "YYYY-MM-DD" strings sort like dates, so < works here.
  if (stop_date < existing.start_date) {
    throw new Error(`stop_date ${stop_date} is before the start date ${existing.start_date}.`);
  }

  const stopped: Medication = { ...existing, status: "stopped", stop_date, stop_reason };
  all[all.indexOf(existing)] = stopped;
  await saveMedications(all);
  return stopped;
}

// --- get_schedule ----------------------------------------------------------

// What get_schedule says about each medicine (only what Claude needs).
type ScheduledMedicine = Pick<Medication, "id" | "name" | "dose" | "with_food">;
const short = (m: Medication): ScheduledMedicine =>
  ({ id: m.id, name: m.name, dose: m.dose, with_food: m.with_food });

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Whole days from one "YYYY-MM-DD" to another (UTC, so no daylight-saving surprises).
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// Dose times on `date` for an every_x_hours medicine. Doses are counted from
// the first dose on start_date and carry on across midnight, so "every 8 h
// from 10:00" gives 10:00, 18:00, then 02:00 the next day, and so on.
function intervalDoseTimes(m: Medication, date: string): string[] {
  const dayStart = daysBetween(m.start_date, date) * 24 * 60; // minutes since start_date 00:00
  const dayEnd = dayStart + 24 * 60;
  const first = toMinutes(m.first_dose_time!);
  const step = m.every_hours! * 60;

  // Jump straight to the first dose on or after the start of `date`.
  let t = first + Math.max(0, Math.ceil((dayStart - first) / step)) * step;
  const times: string[] = [];
  for (; t < dayEnd; t += step) times.push(toHHMM(t - dayStart));
  return times;
}

async function getSchedule(input: unknown) {
  const { date } = ScheduleInput.parse(input);
  const settings = await loadSettings();

  // Only current medicines that are active on this day.
  const active = (await loadMedications()).filter(
    (m) =>
      m.status === "current" &&
      m.start_date <= date &&
      (m.end_date === null || date <= m.end_date),
  );

  // Collect doses by clock time: "08:00" -> { slot, medicines }.
  const byTime = new Map<string, { time: string; slot: string | null; medicines: ScheduledMedicine[] }>();
  const addDose = (time: string, slot: string | null, m: Medication) => {
    const entry = byTime.get(time) ?? { time, slot: null, medicines: [] };
    entry.slot ??= slot;
    entry.medicines.push(short(m));
    byTime.set(time, entry);
  };

  const ifNeeded: ScheduledMedicine[] = [];
  const firstDoseTimeUnknown: (ScheduledMedicine & { every_hours: number | null })[] = [];

  for (const m of active) {
    if (m.timing_type === "times_of_day") {
      for (const slot of m.times_of_day ?? []) addDose(settings.slot_times[slot], slot, m);
    } else if (m.timing_type === "every_x_hours") {
      if (!m.first_dose_time || !m.every_hours) {
        firstDoseTimeUnknown.push({ ...short(m), every_hours: m.every_hours });
      } else {
        for (const time of intervalDoseTimes(m, date)) addDose(time, null, m);
      }
    } else {
      ifNeeded.push(short(m));
    }
  }

  return {
    date,
    doses: [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)),
    if_needed: ifNeeded,
    first_dose_time_unknown: firstDoseTimeUnknown,
  };
}

// The loop in index.ts calls this with whatever tool Claude picked.
// It always returns a tool_result. If something goes wrong, is_error: true
// tells Claude it failed, so it can fix the input or tell the user.
export async function runTool(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  try {
    let result: unknown;
    switch (block.name) {
      case "add_medication":    result = await addMedication(block.input); break;
      case "list_medications":  result = await listMedications(block.input); break;
      case "update_medication": result = await updateMedication(block.input); break;
      case "stop_medication":   result = await stopMedication(block.input); break;
      case "get_schedule":      result = await getSchedule(block.input); break;
      default: throw new Error(`Unknown tool: ${block.name}`);
    }
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
    return { type: "tool_result", tool_use_id: block.id, content: message, is_error: true };
  }
}
