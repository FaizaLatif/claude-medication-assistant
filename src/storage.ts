// Reads and writes my data: data/medications.json, data/profile.json and
// data/settings.json. The files are plain JSON, so you can open them in VS Code.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Where the files live. Normally data/ and exports/ in the project (worked out
// from this file's location, so it works from any folder). The tests switch to
// a temporary folder with setDataFolders(), so they never touch my real data.
// ---------------------------------------------------------------------------
let dataDir = fileURLToPath(new URL("../data/", import.meta.url));
let exportsDir = fileURLToPath(new URL("../exports/", import.meta.url));

export function setDataFolders(newDataDir: string, newExportsDir: string): void {
  dataDir = newDataDir;
  exportsDir = newExportsDir;
}
export const getExportsDir = () => exportsDir;

const medicationsFile = () => join(dataDir, "medications.json");
const profileFile = () => join(dataDir, "profile.json");
const settingsFile = () => join(dataDir, "settings.json");

// One saved medication: what Claude sent, plus the fields our code adds.
export interface Medication {
  id: string;
  status: "current" | "stopped"; // never deleted: stopping only changes the status
  name: string;
  dose: string;
  timing_type: "times_of_day" | "every_x_hours" | "when_needed";
  times_of_day: ("morning" | "lunch" | "evening" | "bedtime")[] | null;
  every_hours: number | null;
  // "HH:MM" of the first dose on start_date, for every_x_hours medicines.
  // Optional (?) because entries saved before Step 5 don't have it.
  first_dose_time?: string | null;
  with_food: "with_food" | "without_food" | "not_specified";
  start_date: string; // "YYYY-MM-DD"
  duration_days: number | null; // null = ongoing
  end_date: string | null; // last day to take it; null = ongoing
  reason: string | null;
  // Who prescribed it, e.g. "Dentist" or "Self / over the counter".
  // Optional (?) because entries saved before Step 6 don't have it.
  prescribed_by?: string | null;
  // Only filled in when stopped. Optional (?) so older saved entries still fit.
  stop_date?: string; // "YYYY-MM-DD"
  stop_reason?: string;
}

export async function loadMedications(): Promise<Medication[]> {
  try {
    const text = await readFile(medicationsFile(), "utf8");
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
  await mkdir(dirname(medicationsFile()), { recursive: true }); // create data/ if missing
  await writeFile(medicationsFile(), JSON.stringify(medications, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Profile: my name, allergies and notes (data/profile.json).
// Created empty on the first run; changed with the update_profile tool.
// ---------------------------------------------------------------------------
export interface Profile {
  name: string | null;
  allergies: string[];
  // "unknown" = never asked, "none_known" = the user said they have no known
  // allergies, "has_allergies" = the list above is not empty.
  // (An empty list alone can't tell "none" apart from "never asked".)
  allergy_status: "unknown" | "none_known" | "has_allergies";
  notes: string[];
}

export async function loadProfile(): Promise<Profile> {
  try {
    const profile = JSON.parse(await readFile(profileFile(), "utf8")) as Profile;
    // Profiles saved before allergy_status existed: work it out from the list.
    profile.allergy_status ??= profile.allergies.length > 0 ? "has_allergies" : "unknown";
    return profile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: Profile = { name: null, allergies: [], allergy_status: "unknown", notes: [] };
      await saveProfile(empty);
      return empty;
    }
    throw err;
  }
}

export async function saveProfile(profile: Profile): Promise<void> {
  await mkdir(dirname(profileFile()), { recursive: true });
  await writeFile(profileFile(), JSON.stringify(profile, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Settings: my usual clock time for each part of the day (data/settings.json).
// Created with these defaults on the first run; edit the file to change them.
// ---------------------------------------------------------------------------
export interface Settings {
  slot_times: { morning: string; lunch: string; evening: string; bedtime: string }; // "HH:MM"
}

const DEFAULT_SETTINGS: Settings = {
  slot_times: { morning: "08:00", lunch: "13:00", evening: "20:00", bedtime: "23:00" },
};

export async function loadSettings(): Promise<Settings> {
  try {
    const settings = JSON.parse(await readFile(settingsFile(), "utf8")) as Settings;
    // The file is edited by hand, so check the times are really "HH:MM".
    for (const slot of ["morning", "lunch", "evening", "bedtime"] as const) {
      const time = settings.slot_times?.[slot];
      if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new Error(`data/settings.json: ${slot} time "${time}" is not HH:MM (e.g. "08:00")`);
      }
    }
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(settingsFile()), { recursive: true });
      await writeFile(settingsFile(), JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf8");
      return DEFAULT_SETTINGS;
    }
    throw err;
  }
}
