// Lesson 3: a chat in the terminal, with tools and a hand-written agent loop.
// Run it with:  npm start   (type "exit" to quit)
//
// Two loops:
//   OUTER loop (the chat): read what I type -> run the agent loop -> repeat.
//   INNER loop (the agent loop, in runAgent):
//     1. Send the conversation to Claude.
//     2. Look at stop_reason:
//          "end_turn"  -> Claude is done; print its answer.
//          "tool_use"  -> run the tool, add the result, go back to step 1.
//          anything else -> stop and say why.
//     3. Never go round more than MAX_TURNS times (a safety net).

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runTool, tools } from "./tools.js";

const client = new Anthropic();
const MODEL = "claude-haiku-5-5";
const MAX_TURNS = 5;

// The current date and time in YOUR time zone, e.g. "[Now: 2026-11-19 17:24, Thursday]".
// Added to the start of every message I type. (Claude has no clock: it only
// knows what we tell it.)
//
// Why not put it in the system prompt? Claude's thinking blocks are tied to
// everything that came before them, system prompt included. If the system
// prompt changes mid-chat (it would, every minute), the earlier thinking
// blocks no longer match and the API answers 400 "Invalid signature in
// thinking block". So the system prompt stays the same for the whole chat,
// and the conversation only ever grows at the end: old messages never change.
function nowPrefix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `[Now: ${date} ${pad(now.getHours())}:${pad(now.getMinutes())}, ${weekday}]`;
}

// Static: exactly the same text on every request (this also makes it cacheable later).
const SYSTEM_PROMPT = `You are a medication assistant. You help the user keep an organised list of what their doctor prescribed.
Each user message starts with the current date and time in [Now: ...] (24-hour clock, the user's local time). Use it for dates and for "what do I take now".

Rules:
- Never guess a dose. If the user hasn't told you the dose, ask for it.
- Only record what the doctor or the leaflet said about food. If the user didn't mention food, use "not_specified".
- You never give medical advice or change a treatment.
- For an every_x_hours medicine, if the time of the first dose is unknown, ask: "What time did you take (or will you take) the first one?" and save it as first_dose_time.
- If get_schedule lists a medicine under first_dose_time_unknown, ask that same question, save the answer with update_medication, then call get_schedule again.
- Who prescribed it (prescribed_by): if the user names who prescribed it (e.g. "the dentist"), save that. If they only say "the doctor", ask once which doctor. If they bought it themselves, use "Self / over the counter". Otherwise use null and don't ask.
- Before saving a NEW medicine, show a one-line summary (name, dose, timing, first dose time, food, start date, duration, reason, prescribed by) and ask the user to confirm. Only call add_medication after they say yes.
- To find a medicine the user mentions, call list_medications and use the id it returns. Never invent an id.
- If the user corrects something already saved, use update_medication with only the fields that change. Never add a second copy.
- If the user stopped taking a medicine, use stop_medication. If they didn't say why, or when, ask before stopping it.
- Never delete medicines. Stopped medicines stay in the history.
- When the user tells you their name, an allergy, or a personal note (e.g. "I'm allergic to penicillin"), save it with update_profile. Before removing an allergy, ask the user to confirm.
- For questions about the user's name, allergies or notes, call get_profile. Never answer them from memory of earlier messages alone.
- When the user asks for a summary or history for family or a doctor, call export_history. If it's unclear who it's for, ask. Use the language the user is writing in (en or pt) unless they ask for another. Tell them the file path and any warnings it returns.
- After saving, updating or stopping, briefly confirm what you did.
- For "what do I take now?" and similar questions, call get_schedule for today. Answer with what is due now (within about an hour of the current time, before or after) and what comes next. If nothing is left today, call get_schedule for tomorrow to find the next dose.
- Answer questions about when to take something ONLY from get_schedule, never from general knowledge.`;

// Guard: the system prompt and tool definitions must be EXACTLY the same on
// every request. A copy is taken once, here at startup, and checked before
// each request. If anything ever changes them, we stop with a clear message
// instead of getting the confusing "Invalid signature in thinking block" 400.
const FIXED_PREFIX = JSON.stringify({ system: SYSTEM_PROMPT, tools });
function checkPrefixUnchanged(): void {
  if (JSON.stringify({ system: SYSTEM_PROMPT, tools }) !== FIXED_PREFIX) {
    throw new Error("The system prompt or tools changed during the chat. They must stay fixed.");
  }
}

// ONE conversation for the whole program. It lives outside both loops,
// so every new message is added to the same list and Claude "remembers".
const messages: Anthropic.MessageParam[] = [];

// The inner loop: keeps calling Claude until it gives a normal answer.
// Returns true if it finished properly, false if something went wrong.
async function runAgent(): Promise<boolean> {
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    checkPrefixUnchanged();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      messages.push({ role: "assistant", content: response.content });
      for (const block of response.content) {
        if (block.type === "text") console.log(`\nAssistant: ${block.text}\n`);
      }
      return true;
    }

    if (response.stop_reason === "tool_use") {
      // Keep Claude's full reply (including the tool_use blocks) in the conversation.
      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        console.log(`  [tool call] ${block.name}`, JSON.stringify(block.input));
        const result = await runTool(block);
        console.log(result.is_error ? "  [tool ERROR]" : "  [tool result]", result.content);
        toolResults.push(result);
      }
      // All tool results go back together, in ONE user message.
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // max_tokens, refusal, etc.: don't run anything, just report it.
    console.log(`\n(Stopped early: stop_reason was "${response.stop_reason}".)\n`);
    return false;
  }

  console.log(`\n(Stopped after ${MAX_TURNS} turns without a final answer.)\n`);
  return true; // the tool results are complete, so the conversation is still valid
}

// The outer loop: the chat itself.
const rl = createInterface({ input: stdin, output: stdout });
console.log('Medication assistant. Type "exit" to quit.');
// If you don't see this line, you're running an old version: exit and npm start again.
console.log(`System prompt: fixed (${SYSTEM_PROMPT.length} characters), ${tools.length} tools.\n`);

while (true) {
  let text: string;
  try {
    text = (await rl.question("You: ")).trim();
  } catch {
    break; // Ctrl+C or the input was closed
  }
  if (text.toLowerCase() === "exit") break;
  if (text === "") continue;

  // Remember where the conversation was, so we can undo this exchange
  // if it breaks halfway (a half-finished exchange makes later calls fail).
  const before = messages.length;
  // Claude gets the time first; the terminal still shows only what I typed.
  messages.push({ role: "user", content: `${nowPrefix()}\n${text}` });

  try {
    const ok = await runAgent();
    if (!ok) {
      messages.length = before;
      console.log("(That message was not kept. Please try again.)\n");
    }
  } catch (err) {
    messages.length = before;
    if (err instanceof Anthropic.APIError) {
      console.log(`\n(API error ${err.status}: ${err.message}. That message was not kept.)\n`);
    } else {
      throw err; // a bug in my own code: show the full error
    }
  }
}

rl.close();
console.log("Bye!");
