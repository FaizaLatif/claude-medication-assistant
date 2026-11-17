// The tools Claude can use. For now there is one: add_medication.
//
// Each tool has two halves:
//   1. A definition (name + description + JSON schema) that we SEND to Claude,
//      so it knows the tool exists and what to fill in.
//   2. A function that RUNS on your computer when Claude asks to use it.

import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadMedications, saveMedications, type Medication } from "./storage.js";

// ---------------------------------------------------------------------------
// 1. The definition sent to Claude
// ---------------------------------------------------------------------------
// strict: true means Claude's input is guaranteed to match this schema.
// Strict mode has some rules:
//   - every object needs additionalProperties: false
//   - every field must be listed in "required" (optional = allow null instead)
//   - number limits like minimum/maximum are NOT supported, so "1-24" is
//     written in the description and checked by zod below instead.
export const addMedicationTool: Anthropic.Tool = {
  name: "add_medication",
  description:
    "Save a medication to the user's list. Only call this when the name, dose, " +
    "timing and start date are all known. Never guess a dose: if the user did " +
    "not say it, ask them instead of calling this tool.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
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
    },
    required: [
      "name", "dose", "timing_type", "times_of_day", "every_hours",
      "with_food", "start_date", "duration_days", "reason",
    ],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// 2. A second check in our own code (zod)
// ---------------------------------------------------------------------------
// Strict mode checks the shape. Zod also checks the rules strict mode can't:
// the 1-24 range, and that the timing fields match the timing_type.
const AddMedicationInput = z
  .object({
    name: z.string().min(1),
    dose: z.string().min(1),
    timing_type: z.enum(["times_of_day", "every_x_hours", "when_needed"]),
    times_of_day: z.array(z.enum(["morning", "lunch", "evening", "bedtime"])).nullable(),
    every_hours: z.int().min(1).max(24).nullable(),
    with_food: z.enum(["with_food", "without_food", "not_specified"]),
    start_date: z.iso.date(),
    duration_days: z.int().min(1).nullable(),
    reason: z.string().nullable(),
  })
  .refine((m) => m.timing_type !== "times_of_day" || (m.times_of_day?.length ?? 0) > 0, {
    message: "times_of_day is required when timing_type is times_of_day",
  })
  .refine((m) => m.timing_type !== "every_x_hours" || m.every_hours !== null, {
    message: "every_hours is required when timing_type is every_x_hours",
  });

// ---------------------------------------------------------------------------
// 3. The function that runs when Claude calls the tool
// ---------------------------------------------------------------------------
// end_date = the LAST day you take it. "4 days starting 17 Nov" means the
// 17th, 18th, 19th and 20th, so we add (duration_days - 1).
function calculateEndDate(startDate: string, durationDays: number | null): string | null {
  if (durationDays === null) return null; // ongoing
  const date = new Date(`${startDate}T00:00:00Z`); // UTC avoids daylight-saving surprises
  date.setUTCDate(date.getUTCDate() + durationDays - 1);
  return date.toISOString().slice(0, 10);
}

async function addMedication(input: unknown): Promise<Medication> {
  const parsed = AddMedicationInput.parse(input); // throws if something is wrong
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

// The loop in index.ts calls this with whatever tool Claude picked.
// It always returns a tool_result. If something goes wrong, is_error: true
// tells Claude it failed, so it can fix the input or tell the user.
export async function runTool(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  try {
    if (block.name !== "add_medication") throw new Error(`Unknown tool: ${block.name}`);
    const saved = await addMedication(block.input);
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(saved) };
  } catch (err) {
    const message = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
    return { type: "tool_result", tool_use_id: block.id, content: message, is_error: true };
  }
}
