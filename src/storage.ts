// Reads and writes your medication list in data/medications.json.
// The file is plain JSON, so you can open it in VS Code and look at it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The path is worked out from this file's location (src/), so it works
// no matter which folder you run the command from.
const DATA_FILE = fileURLToPath(new URL("../data/medications.json", import.meta.url));

// One saved medication: what Claude sent, plus the fields our code adds.
export interface Medication {
  id: string;
  status: "current";
  name: string;
  dose: string;
  timing_type: "times_of_day" | "every_x_hours" | "when_needed";
  times_of_day: ("morning" | "lunch" | "evening" | "bedtime")[] | null;
  every_hours: number | null;
  with_food: "with_food" | "without_food" | "not_specified";
  start_date: string; // "YYYY-MM-DD"
  duration_days: number | null; // null = ongoing
  end_date: string | null; // last day to take it; null = ongoing
  reason: string | null;
}

export async function loadMedications(): Promise<Medication[]> {
  try {
    const text = await readFile(DATA_FILE, "utf8");
    return JSON.parse(text) as Medication[];
  } catch (err) {
    // First run: the file doesn't exist yet, so create it with an empty list.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await saveMedications([]);
      return [];
    }
    throw err; // any other problem (e.g. broken JSON) should be shown, not hidden
  }
}

export async function saveMedications(medications: Medication[]): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true }); // create data/ if missing
  await writeFile(DATA_FILE, JSON.stringify(medications, null, 2) + "\n", "utf8");
}
