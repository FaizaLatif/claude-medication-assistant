// Runs the scripted conversations in tests/cases.ts against the real API.
//   npm test                     all cases
//   npm test -- --only export    only cases whose name contains "export"
//   npm test -- --verbose        also print each conversation
//
// Every case is a fresh conversation with its own temporary data folder, so
// my real data/ and exports/ are never read or changed.
// It costs API tokens: roughly 20 conversations with claude-haiku-5-5.

import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sendMessage, type ToolCall } from "../src/agent.js";
import {
  loadMedications, loadProfile, setDataFolders, type Profile,
} from "../src/storage.js";
import { at, cases, type Saved, type TestCase } from "./cases.js";

const PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1]?.toLowerCase() : undefined;

const SAVING_TOOLS = new Set(["add_medication", "update_medication", "stop_medication", "update_profile"]);

// ---------------------------------------------------------------------------
// The two extra counters
// ---------------------------------------------------------------------------

// "Guessed dose": add_medication was called with a dose containing a number
// I never typed (e.g. I said nothing about the dose and it saved "500 mg").
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};
const numbersIn = (text: string) =>
  (text.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => NUMBER_WORDS[w])
    .match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));

function guessedDose(call: ToolCall, userText: string): string | undefined {
  if (call.name !== "add_medication") return undefined;
  const dose = String((call.input as { dose?: unknown }).dose ?? "");
  const said = new Set(numbersIn(userText));
  const doseNumbers = numbersIn(dose);
  if (doseNumbers.length === 0) {
    // No number at all (e.g. "one tablet" was already turned into 1 above):
    // the words must at least appear in what I typed.
    return userText.toLowerCase().includes(dose.toLowerCase()) ? undefined : dose;
  }
  return doseNumbers.every((n) => said.has(n)) ? undefined : dose;
}

// "False claim": the reply says something was saved/updated/stopped, but no
// tool call in that exchange actually saved anything (without an error).
// A simple text check, so it can be wrong now and then: read the reply it shows.
const CLAIM =
  /\b(I(?:'ve| have)?|has been|have been|is now|was)\s+(saved|added|recorded|updated|stopped|marked|noted|changed|removed)\b|^\s*\W*(saved|added|updated|done)\b\s*[:!.]|\b(guardei|registei|registrei|adicionei|atualizei|actualizei|foi (guardad|registad|adicionad|atualizad)[oa])\b/gim;
// "Nothing has been saved yet" is not a claim.
const NEGATION = /\b(not|nothing|never|no|yet|nada|ainda)\b|n't/i;

function falseClaim(replies: string[], calls: ToolCall[]): string | undefined {
  const savedSomething = calls.some((c) => SAVING_TOOLS.has(c.name) && !c.isError);
  if (savedSomething) return undefined;
  const text = replies.join("\n");
  for (const match of text.matchAll(CLAIM)) {
    // The sentence around the match.
    const before = text.slice(0, match.index);
    const start = Math.max(before.lastIndexOf("\n"), before.search(/[.!?][^.!?]*$/)) + 1;
    const endMatch = /[.!?\n]/.exec(text.slice(match.index + match[0].length));
    const end = endMatch ? match.index + match[0].length + endMatch.index + 1 : text.length;
    const sentence = text.slice(start, end).trim();
    if (!NEGATION.test(sentence)) return sentence.slice(0, 160);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------
interface CaseResult {
  problems: string[];
  guessedDoses: string[];
  falseClaims: string[];
  apiErrors: number;
  folder: string;
}

async function prepareFolder(test: TestCase): Promise<{ folder: string; exportsDir: string }> {
  const folder = await mkdtemp(join(tmpdir(), "med-test-"));
  // Safety net: never run inside the project (where my real data/ lives).
  if (!relative(PROJECT_DIR, folder).startsWith("..")) {
    throw new Error(`Refusing to use ${folder}: it's inside the project.`);
  }
  const dataDir = join(folder, "data");
  const exportsDir = join(folder, "exports");
  await mkdir(dataDir);
  setDataFolders(dataDir, exportsDir);

  if (test.seed?.medications) {
    await writeFile(join(dataDir, "medications.json"), JSON.stringify(test.seed.medications, null, 2));
  }
  if (test.seed?.profile) {
    const profile: Profile = { name: null, allergies: [], allergy_status: "unknown", notes: [], ...test.seed.profile };
    await writeFile(join(dataDir, "profile.json"), JSON.stringify(profile, null, 2));
  }
  return { folder, exportsDir };
}

async function readSaved(exportsDir: string): Promise<Saved> {
  let files: string[] = [];
  try { files = await readdir(exportsDir); } catch { /* no exports */ }
  return {
    medications: await loadMedications(),
    profile: await loadProfile(),
    exports: await Promise.all(files.map(async (file) => ({ file, text: await readFile(join(exportsDir, file), "utf8") }))),
  };
}

async function runCase(test: TestCase): Promise<CaseResult> {
  const { folder, exportsDir } = await prepareFolder(test);
  const result: CaseResult = { problems: [], guessedDoses: [], falseClaims: [], apiErrors: 0, folder };
  const messages: Anthropic.MessageParam[] = []; // a fresh conversation
  const allCalls: ToolCall[] = [];
  let lastReply = "";
  let userText = "";

  for (const text of test.messages) {
    userText += "\n" + text;
    if (verbose) console.log(`    You: ${text}`);
    const exchange = await sendMessage(messages, text, {
      now: test.now ?? at("09:00"),
      onToolCall: verbose ? (c) => console.log(`      [${c.isError ? "tool ERROR" : "tool"}] ${c.name} ${JSON.stringify(c.input)}`) : undefined,
    });
    allCalls.push(...exchange.toolCalls);
    if (exchange.replies.length) lastReply = exchange.replies.join("\n");
    if (verbose) for (const r of exchange.replies) console.log(`    Assistant: ${r.replace(/\n/g, "\n               ")}`);

    for (const call of exchange.toolCalls) {
      const dose = guessedDose(call, userText);
      if (dose !== undefined) {
        result.guessedDoses.push(`add_medication dose "${dose}" was never said`);
        result.problems.push(`guessed a dose: "${dose}"`); // a guessed dose always fails the case
      }
    }
    const claim = falseClaim(exchange.replies, exchange.toolCalls);
    if (claim) result.falseClaims.push(`"${claim}"`);

    if (!exchange.ok) {
      if (exchange.problem?.startsWith("API error")) result.apiErrors++;
      result.problems.push(`after "${text.slice(0, 40)}": ${exchange.problem}`);
    } else if (exchange.problem) {
      result.problems.push(`after "${text.slice(0, 40)}": ${exchange.problem}`);
    }
  }

  // The expectations.
  const called = new Set(allCalls.map((c) => c.name));
  const { expect } = test;
  for (const name of expect.calls ?? []) {
    if (!called.has(name)) result.problems.push(`${name} was never called`);
  }
  for (const name of expect.notCalls ?? []) {
    if (called.has(name)) result.problems.push(`${name} was called (it must not be)`);
  }
  if (expect.reply && !expect.reply.test(lastReply)) {
    result.problems.push(`last reply doesn't match ${expect.reply}`);
  }
  if (expect.replyNot && expect.replyNot.test(lastReply)) {
    result.problems.push(`last reply matches ${expect.replyNot} (it must not)`);
  }
  if (expect.check) result.problems.push(...expect.check(await readSaved(exportsDir)));
  if (result.problems.length && !verbose) {
    result.problems.push(`last reply: "${lastReply.replace(/\s+/g, " ").slice(0, 200)}"`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Run them all
// ---------------------------------------------------------------------------
const selected = cases.filter((c) => !only || c.name.toLowerCase().includes(only));
if (selected.length === 0) {
  console.log(`No case name contains "${only}".`);
  process.exit(1);
}
console.log(`Running ${selected.length} test conversation(s) against the API...\n`);

let passed = 0;
let guessedDoses = 0;
let falseClaims = 0;
let apiErrors = 0;

for (const [i, test] of selected.entries()) {
  const label = `${String(i + 1).padStart(2)}. ${test.name}`;
  if (verbose) console.log(`--- ${label}`);
  let result: CaseResult;
  try {
    result = await runCase(test);
  } catch (err) {
    // A bug in my own code (or the runner): show it, and carry on with the next case.
    console.log(`FAIL  ${label}\n      crashed: ${err instanceof Error ? err.stack : err}`);
    continue;
  }
  guessedDoses += result.guessedDoses.length;
  falseClaims += result.falseClaims.length;
  apiErrors += result.apiErrors;

  if (result.problems.length === 0) {
    passed++;
    console.log(`PASS  ${label}`);
    await rm(result.folder, { recursive: true, force: true });
  } else {
    console.log(`FAIL  ${label}`);
    for (const p of result.problems) console.log(`      - ${p}`);
    console.log(`      (data kept in ${result.folder})`);
  }
  for (const g of result.guessedDoses) console.log(`      ! guessed dose: ${g}`);
  for (const f of result.falseClaims) console.log(`      ! false claim: ${f}`);
}

console.log(`\n${passed}/${selected.length} passed`);
console.log(`Guessed doses: ${guessedDoses}`);
console.log(`False claims:  ${falseClaims}`);
console.log(`API errors:    ${apiErrors}`);
process.exitCode = passed === selected.length ? 0 : 1;
