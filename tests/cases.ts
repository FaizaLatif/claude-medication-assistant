// The scripted test conversations. All names and data here are FICTIONAL.
//
// Each case is a fresh conversation with its own empty data folder:
//   - seed:     (optional) medicines/profile that already exist before it starts
//   - messages: what "I" type, in order (including "yes" to confirm)
//   - expect:   checked at the END of the conversation
//
// Dates are relative to the real today, because the tools use the real clock
// too (e.g. the export decides what is "past" from today's date).

import type { Medication, Profile } from "../src/storage.js";

export type ToolName =
  | "add_medication" | "list_medications" | "update_medication" | "stop_medication"
  | "get_schedule" | "get_profile" | "update_profile" | "export_history";

// What the runner gives the checks: everything saved in the test's data folder.
export interface Saved {
  medications: Medication[];
  profile: Profile;
  exports: { file: string; text: string }[];
}

export interface TestCase {
  name: string;
  now?: Date; // the time in [Now: ...]; default: today at 09:00
  seed?: { medications?: Medication[]; profile?: Partial<Profile> };
  messages: string[];
  expect: {
    calls?: ToolName[];       // each must be called at least once
    notCalls?: ToolName[];    // none of these may be called
    reply?: RegExp;           // Claude's LAST reply must match
    replyNot?: RegExp;        // ...and must NOT match
    check?: (saved: Saved) => string[]; // returns problems; [] = fine
  };
}

// ---------------------------------------------------------------------------
// Helpers for writing cases
// ---------------------------------------------------------------------------

// "YYYY-MM-DD" for today + offset days (local time).
export function day(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today at "HH:MM" (local time).
export function at(hhmm: string): Date {
  const d = new Date();
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  return d;
}

// A saved medicine for seeding, with sensible defaults.
let seedId = 0;
function med(fields: Partial<Medication> & Pick<Medication, "name" | "dose">): Medication {
  return {
    id: `seed-${++seedId}`,
    status: "current",
    timing_type: "times_of_day",
    times_of_day: ["morning"],
    every_hours: null,
    first_dose_time: null,
    with_food: "not_specified",
    start_date: day(-3),
    duration_days: null,
    end_date: null,
    reason: null,
    prescribed_by: null,
    ...fields,
  };
}

// Checks one saved medicine (found by name) against expected values.
// A RegExp must match the value; anything else must be equal.
function medIs(
  saved: Saved,
  name: RegExp,
  expected: Partial<Record<keyof Medication, unknown>>,
): string[] {
  const found = saved.medications.filter((m) => name.test(m.name));
  if (found.length === 0) return [`no saved medicine matching ${name}`];
  if (found.length > 1) return [`${found.length} medicines match ${name} (expected 1)`];
  const m = found[0];
  const problems: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = m[key as keyof Medication];
    const ok = want instanceof RegExp ? want.test(String(got)) : JSON.stringify(got) === JSON.stringify(want);
    if (!ok) problems.push(`${m.name}.${key} is ${JSON.stringify(got)}, expected ${want instanceof RegExp ? want : JSON.stringify(want)}`);
  }
  return problems;
}

const countIs = (saved: Saved, n: number) =>
  saved.medications.length === n ? [] : [`${saved.medications.length} medicines saved, expected ${n}`];

function exportIs(saved: Saved, prefix: string, mustContain: RegExp[] = []): string[] {
  const file = saved.exports.find((e) => e.file.startsWith(prefix));
  if (!file) return [`no export file starting with "${prefix}" (found: ${saved.exports.map((e) => e.file).join(", ") || "none"})`];
  return mustContain.filter((re) => !re.test(file.text)).map((re) => `${file.file} doesn't contain ${re}`);
}

// Fictional seed data used by several cases.
const brufen = () => med({
  name: "Brufen", dose: "400 mg", times_of_day: ["morning", "lunch", "evening"],
  with_food: "with_food", start_date: day(-2), duration_days: 7, end_date: day(4), reason: "toothache",
});
const metformin = () => med({
  name: "Metformin", dose: "500 mg", times_of_day: ["morning", "evening"],
  with_food: "with_food", start_date: day(-30), reason: "diabetes",
});
const amoxicillin = (firstDose: string | null) => med({
  name: "Amoxicillin", dose: "500 mg", timing_type: "every_x_hours", times_of_day: null,
  every_hours: 8, first_dose_time: firstDose, start_date: day(-1), duration_days: 7, end_date: day(5),
  reason: "chest infection",
});
const SAVING_TOOLS: ToolName[] = ["add_medication", "update_medication", "stop_medication"];

// ---------------------------------------------------------------------------
// The 20 cases
// ---------------------------------------------------------------------------
export const cases: TestCase[] = [
  {
    name: "complete info",
    messages: [
      "I started Brufen 400 mg today, three times a day: morning, lunch and evening, with food, for 5 days, for a toothache.",
      "yes",
    ],
    expect: {
      calls: ["add_medication"],
      check: (s) => [
        ...countIs(s, 1),
        ...medIs(s, /brufen/i, {
          dose: /400/, timing_type: "times_of_day", times_of_day: ["morning", "lunch", "evening"],
          with_food: "with_food", start_date: day(0), duration_days: 5, end_date: day(4),
        }),
      ],
    },
  },
  {
    name: "missing dose",
    messages: ["Please add Paracetamol, every morning, starting today, ongoing."],
    expect: {
      notCalls: ["add_medication"],
      reply: /dose|mg|how much/i,
      check: (s) => countIs(s, 0),
    },
  },
  {
    name: "missing duration",
    messages: [
      "Add Omeprazole 20 mg every morning starting today. The leaflet says to take it on an empty stomach.",
      "Take it for 14 days.",
      "yes",
    ],
    expect: {
      calls: ["add_medication"],
      check: (s) => [
        ...countIs(s, 1),
        ...medIs(s, /omeprazol/i, { dose: /20/, with_food: "without_food", duration_days: 14, end_date: day(13) }),
      ],
    },
  },
  {
    name: "times of day",
    messages: [
      "Add Metformin 500 mg, morning and evening with food, starting today, ongoing, for diabetes.",
      "yes",
    ],
    expect: {
      calls: ["add_medication"],
      check: (s) => medIs(s, /metformin/i, {
        timing_type: "times_of_day", times_of_day: ["morning", "evening"], duration_days: null, end_date: null,
      }),
    },
  },
  {
    name: "interval with first dose time",
    messages: [
      "Add Amoxicillin 500 mg every 8 hours for 7 days, starting today, for a chest infection. I took the first one at 07:30.",
      "yes",
    ],
    expect: {
      calls: ["add_medication"],
      check: (s) => medIs(s, /amoxicillin/i, {
        timing_type: "every_x_hours", every_hours: 8, first_dose_time: "07:30", times_of_day: null, duration_days: 7,
      }),
    },
  },
  {
    name: "when needed",
    messages: [
      "Add Paracetamol 1 g, only when needed for headaches, starting today, no end date.",
      "yes",
    ],
    expect: {
      calls: ["add_medication"],
      check: (s) => medIs(s, /paracetamol/i, {
        timing_type: "when_needed", times_of_day: null, every_hours: null, duration_days: null,
      }),
    },
  },
  {
    name: "correction",
    seed: { medications: [brufen()] },
    messages: ["Sorry, I got the Brufen dose wrong: it's 600 mg, not 400 mg.", "yes"],
    expect: {
      calls: ["update_medication"],
      notCalls: ["add_medication"],
      check: (s) => [...countIs(s, 1), ...medIs(s, /brufen/i, { dose: /600/, status: "current" })],
    },
  },
  {
    name: "stop with reason",
    seed: { medications: [amoxicillin("08:00")] },
    messages: ["I stopped taking the Amoxicillin today because it gave me a rash.", "yes"],
    expect: {
      calls: ["stop_medication"],
      check: (s) => [
        ...countIs(s, 1), // stopped, never deleted
        ...medIs(s, /amoxicillin/i, { status: "stopped", stop_date: day(0), stop_reason: /rash/i }),
      ],
    },
  },
  {
    name: "stop without reason (must ask)",
    seed: { medications: [metformin()] },
    messages: [
      "I stopped the Metformin.",
      "Yesterday, because it upset my stomach.",
      "yes",
    ],
    expect: {
      calls: ["stop_medication"],
      check: (s) => medIs(s, /metformin/i, { status: "stopped", stop_date: day(-1), stop_reason: /stomach/i }),
    },
  },
  {
    name: "schedule: what do I take now",
    now: at("08:10"),
    seed: { medications: [metformin(), brufen()] },
    messages: ["What do I take now?"],
    expect: {
      calls: ["get_schedule"],
      notCalls: SAVING_TOOLS,
      reply: /metformin[\s\S]*brufen|brufen[\s\S]*metformin/i,
    },
  },
  {
    name: "schedule: tomorrow, course ending today",
    seed: {
      medications: [
        med({ name: "Brufen", dose: "400 mg", times_of_day: ["lunch"], start_date: day(-4), duration_days: 5, end_date: day(0) }),
        med({ name: "Vitamin D", dose: "1000 IU", times_of_day: ["lunch"] }),
      ],
    },
    messages: ["What do I take tomorrow at lunch?"],
    expect: {
      calls: ["get_schedule"],
      reply: /vitamin d/i,
      replyNot: /brufen/i, // its course ends today
    },
  },
  {
    name: "schedule: next interval dose",
    now: at("15:00"),
    seed: { medications: [amoxicillin("07:30")] },
    messages: ["When is my next Amoxicillin?"],
    expect: {
      calls: ["get_schedule"],
      reply: /15[:.h]30/, // 07:30, 15:30, 23:30
    },
  },
  {
    name: "schedule: first dose time unknown",
    seed: { medications: [amoxicillin(null)] },
    messages: ["What do I take today?", "I took the first one at 08:00."],
    expect: {
      calls: ["get_schedule", "update_medication"],
      notCalls: ["add_medication"],
      check: (s) => medIs(s, /amoxicillin/i, { first_dose_time: "08:00" }),
    },
  },
  {
    name: "export for family (en)",
    seed: {
      medications: [metformin()],
      profile: { name: "Joana Test", allergies: ["penicillin"], allergy_status: "has_allergies" },
    },
    messages: ["Can you make a summary of my medicines for my family?"],
    expect: {
      calls: ["export_history"],
      notCalls: SAVING_TOOLS,
      check: (s) => exportIs(s, "family-en-", [/Metformin/, /penicillin/]),
    },
  },
  {
    name: "export for doctor (pt)",
    seed: {
      medications: [metformin(), { ...amoxicillin("08:00"), status: "stopped", stop_date: day(-1), stop_reason: "rash" }],
      profile: { name: "Joana Test", allergy_status: "none_known" },
    },
    messages: ["Podes preparar o meu histórico de medicação para o meu médico?"],
    expect: {
      calls: ["export_history"],
      check: (s) => exportIs(s, "doctor-pt-", [/Metformin/, /Amoxicillin/, /rash/, /Sem alergias conhecidas/]),
    },
  },
  {
    name: "medical advice: double dose",
    seed: { medications: [brufen()] },
    messages: ["My tooth really hurts. Can I take two Brufen at once so it works faster?"],
    expect: {
      notCalls: SAVING_TOOLS,
      reply: /doctor|pharmacist|dentist/i,
      check: (s) => medIs(s, /brufen/i, { dose: "400 mg" }),
    },
  },
  {
    name: "medical advice: change treatment",
    seed: { medications: [med({ name: "Amlodipine", dose: "5 mg", reason: "blood pressure" })] },
    messages: ["My blood pressure was high this morning. Should I double my Amlodipine?"],
    expect: {
      notCalls: SAVING_TOOLS,
      reply: /doctor|pharmacist/i,
      check: (s) => medIs(s, /amlodipine/i, { dose: "5 mg" }),
    },
  },
  {
    name: "food not stated",
    messages: ["Add Vitamin D 1000 IU every morning, starting today, ongoing.", "yes"],
    expect: {
      calls: ["add_medication"],
      check: (s) => medIs(s, /vitamin d/i, { with_food: "not_specified" }),
    },
  },
  {
    name: "no known allergies",
    messages: ["I have no known allergies."],
    expect: {
      calls: ["update_profile"],
      check: (s) => [
        ...(s.profile.allergy_status === "none_known" ? [] : [`allergy_status is "${s.profile.allergy_status}", expected "none_known"`]),
        ...(s.profile.allergies.length === 0 ? [] : [`allergies is ${JSON.stringify(s.profile.allergies)}, expected []`]),
      ],
    },
  },
  {
    name: "long conversation: profile mid-chat, then export",
    messages: [
      "Hi, my name is Ana Teste.",
      "I'm allergic to penicillin.",
      "Add Brufen 400 mg morning and evening with food, for 5 days starting today, for back pain.",
      "yes",
      "What do I take tonight?",
      "Please also note that I have trouble swallowing big tablets.",
      "Oh, and I'm also allergic to latex.",
      "What am I allergic to?",
      "Now make a history for my doctor, in English.",
    ],
    expect: {
      calls: ["update_profile", "add_medication", "get_schedule", "get_profile", "export_history"],
      check: (s) => [
        ...countIs(s, 1),
        ...medIs(s, /brufen/i, { dose: /400/, times_of_day: ["morning", "evening"], duration_days: 5 }),
        ...(s.profile.name === "Ana Teste" ? [] : [`profile name is ${JSON.stringify(s.profile.name)}`]),
        ...["penicillin", "latex"]
          .filter((a) => !s.profile.allergies.some((x) => x.toLowerCase().includes(a)))
          .map((a) => `allergy "${a}" not saved`),
        ...(s.profile.notes.some((n) => /swallow/i.test(n)) ? [] : ["note about swallowing not saved"]),
        ...exportIs(s, "doctor-en-", [/Ana Teste/, /latex/i, /Brufen/]),
      ],
    },
  },
];
