// Builds the history export: a Markdown file in exports/ for family or a doctor,
// in English or Portuguese. Used by the export_history tool in tools.ts.
//
// Everything here is plain code: Claude only chooses the audience and language.
// The content comes straight from my saved data, so nothing is made up.

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getExportsDir, loadMedications, loadProfile, loadSettings,
  type Medication, type Profile, type Settings,
} from "./storage.js";

export type Audience = "family" | "doctor";
export type Language = "en" | "pt";

const PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));

// ---------------------------------------------------------------------------
// The wording, in both languages. Medicine names, doses and my own reasons are
// NOT translated: they are written exactly as I entered them.
// ---------------------------------------------------------------------------
const TEXT = {
  en: {
    titleFamily: "Medication summary",
    titleDoctor: "Medication history",
    generatedOn: "Generated on",
    name: "Name",
    notRecorded: "(not recorded)",
    allergies: "Allergies",
    noKnownAllergies: "No known allergies",
    allergiesNotRecorded: "Not recorded (ask the patient)",
    noneRecorded: "None recorded",
    notes: "Notes",
    current: "Current medicines",
    noCurrent: "No current medicines recorded.",
    past: "Past medicines",
    noPast: "No past medicines recorded.",
    medicine: "Medicine",
    dose: "Dose",
    whenToTake: "When to take",
    food: "Food",
    start: "Start",
    end: "End",
    until: "Until",
    ongoing: "Ongoing",
    prescribedBy: "Prescribed by",
    reason: "Reason",
    whyStopped: "Why stopped",
    courseCompleted: "Course completed",
    slots: { morning: "Morning", lunch: "Lunch", evening: "Evening", bedtime: "Bedtime" },
    everyHours: (h: number) => `Every ${h} hours`,
    firstDose: (t: string) => `first dose at ${t}`,
    firstDoseUnknown: "first dose time not recorded",
    whenNeeded: "Only if needed",
    withFood: { with_food: "With food", without_food: "Without food", not_specified: "—" },
    disclaimer: "Generated from the patient's own records. Please confirm with the patient.",
  },
  pt: {
    titleFamily: "Resumo da medicação",
    titleDoctor: "Histórico de medicação",
    generatedOn: "Gerado em",
    name: "Nome",
    notRecorded: "(não registado)",
    allergies: "Alergias",
    noKnownAllergies: "Sem alergias conhecidas",
    allergiesNotRecorded: "Não registado (perguntar ao doente)",
    noneRecorded: "Nenhuma registada",
    notes: "Notas",
    current: "Medicação atual",
    noCurrent: "Nenhuma medicação atual registada.",
    past: "Medicação anterior",
    noPast: "Nenhuma medicação anterior registada.",
    medicine: "Medicamento",
    dose: "Dose",
    whenToTake: "Quando tomar",
    food: "Refeições",
    start: "Início",
    end: "Fim",
    until: "Até",
    ongoing: "Contínuo",
    prescribedBy: "Prescrito por",
    reason: "Motivo",
    whyStopped: "Motivo da paragem",
    courseCompleted: "Tratamento concluído",
    slots: { morning: "Manhã", lunch: "Almoço", evening: "Noite", bedtime: "Ao deitar" },
    everyHours: (h: number) => `De ${h} em ${h} horas`,
    firstDose: (t: string) => `primeira toma às ${t}`,
    firstDoseUnknown: "hora da primeira toma não registada",
    whenNeeded: "Só se necessário",
    withFood: { with_food: "Com alimentos", without_food: "Sem alimentos", not_specified: "—" },
    disclaimer: "Gerado a partir dos registos do próprio doente. Por favor, confirme com o doente.",
  },
};
type Text = (typeof TEXT)["en"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Today in MY time zone, as "YYYY-MM-DD".
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Text inside a Markdown table cell can't contain "|" or line breaks.
const cell = (value: string | null | undefined) =>
  (value && value.trim() ? value : "—").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function table(headers: string[], rows: (string | null)[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

const list = (items: string[], t: Text) =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${t.noneRecorded}`;

// "No known allergies" (the user said so) is different from "never asked".
function allergyList(profile: Profile, t: Text): string {
  if (profile.allergies.length > 0) return list(profile.allergies, t);
  return `- ${profile.allergy_status === "none_known" ? t.noKnownAllergies : t.allergiesNotRecorded}`;
}

// "Morning (08:00), Bedtime (23:00)" / "Every 6 hours, first dose at 09:00" / "Only if needed"
function whenToTake(m: Medication, t: Text, settings: Settings): string {
  if (m.timing_type === "times_of_day") {
    return (m.times_of_day ?? [])
      .map((slot) => `${t.slots[slot]} (${settings.slot_times[slot]})`)
      .join(", ");
  }
  if (m.timing_type === "every_x_hours") {
    const first = m.first_dose_time ? t.firstDose(m.first_dose_time) : t.firstDoseUnknown;
    return `${t.everyHours(m.every_hours ?? 0)}, ${first}`;
  }
  return t.whenNeeded;
}

// A medicine is "past" if it was stopped, or if its course has finished.
const isPast = (m: Medication, today: string) =>
  m.status === "stopped" || (m.end_date !== null && m.end_date < today);

// The day a past medicine ended: the stop date, or the planned last day.
const endedOn = (m: Medication) => m.stop_date ?? m.end_date ?? "";

// ---------------------------------------------------------------------------
// Build the Markdown and write the file
// ---------------------------------------------------------------------------
export async function exportHistory(audience: Audience, language: Language) {
  const t = TEXT[language];
  const today = localToday();
  const [profile, medications, settings] =
    await Promise.all([loadProfile(), loadMedications(), loadSettings()]);

  const current = medications.filter((m) => !isPast(m, today));
  const past = medications
    .filter((m) => isPast(m, today))
    .sort((a, b) => endedOn(b).localeCompare(endedOn(a))); // newest first

  const lines: string[] = [];
  lines.push(`# ${audience === "family" ? t.titleFamily : t.titleDoctor}`, "");
  lines.push(`**${t.name}:** ${profile.name ?? t.notRecorded}  `);
  lines.push(`**${t.generatedOn}:** ${today}`, "");

  lines.push(`## ${t.allergies}`, "", allergyList(profile, t), "");

  if (audience === "doctor") {
    lines.push(`## ${t.notes}`, "", list(profile.notes, t), "");
  }

  lines.push(`## ${t.current}`, "");
  if (current.length === 0) {
    lines.push(t.noCurrent);
  } else if (audience === "family") {
    lines.push(table(
      [t.medicine, t.dose, t.whenToTake, t.food, t.until],
      current.map((m) => [
        m.name, m.dose, whenToTake(m, t, settings), t.withFood[m.with_food], m.end_date ?? t.ongoing,
      ]),
    ));
  } else {
    lines.push(table(
      [t.medicine, t.dose, t.whenToTake, t.food, t.start, t.until, t.prescribedBy, t.reason],
      current.map((m) => [
        m.name, m.dose, whenToTake(m, t, settings), t.withFood[m.with_food],
        m.start_date, m.end_date ?? t.ongoing, m.prescribed_by ?? null, m.reason,
      ]),
    ));
  }
  lines.push("");

  if (audience === "doctor") {
    lines.push(`## ${t.past}`, "");
    if (past.length === 0) {
      lines.push(t.noPast);
    } else {
      lines.push(table(
        [t.medicine, t.dose, t.start, t.end, t.whyStopped, t.prescribedBy, t.reason],
        past.map((m) => [
          m.name, m.dose, m.start_date, endedOn(m),
          m.stop_reason ?? t.courseCompleted, m.prescribed_by ?? null, m.reason,
        ]),
      ));
    }
    lines.push("", "---", "", `*${t.disclaimer}*`);
  }

  // e.g. exports/doctor-en-2026-11-19.md (same day + same type = replaced)
  const fileName = `${audience}-${language}-${today}.md`;
  const file = join(getExportsDir(), fileName);
  await mkdir(getExportsDir(), { recursive: true });
  await writeFile(file, lines.join("\n") + "\n", "utf8");

  // Things Claude should mention to me, so the export isn't silently incomplete.
  const warnings: string[] = [];
  if (!profile.name) warnings.push("The profile has no name. Ask the user for it and save it with update_profile.");
  if (profile.allergy_status === "unknown") {
    warnings.push(
      "Allergies have not been recorded. Ask the user; if they have none, " +
      "save allergy_status \"none_known\" with update_profile.",
    );
  }

  // "exports/doctor-en-2026-11-19.md" normally; the full path during tests.
  const fromProject = relative(PROJECT_DIR, file);
  const path = fromProject.startsWith("..") ? file : fromProject.replace(/\\/g, "/");
  return { path, warnings };
}
