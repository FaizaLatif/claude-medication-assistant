// The agent: the system prompt plus the hand-written agent loop.
// Used by BOTH the terminal chat (index.ts) and the automated tests
// (tests/run.ts), so there is only one copy of this logic.
//
// sendMessage() handles one message I send:
//   1. Add my message (with [Now: ...] in front) to the conversation.
//   2. The agent loop:
//        send the conversation to Claude, then look at stop_reason:
//          "end_turn"  -> Claude is done; keep its answer.
//          "tool_use"  -> run the tool, add the result, go round again.
//          anything else -> stop and say why.
//        Never go round more than MAX_TURNS times (a safety net).
//   3. If it broke halfway, undo my message, so the conversation stays valid.

import Anthropic from "@anthropic-ai/sdk";
import { runTool, tools } from "./tools.js";

export const MODEL = "claude-haiku-5-5";
const MAX_TURNS = 5;

// The current date and time in MY time zone, e.g. "[Now: 2026-11-19 17:24, Thursday]".
// Added to the start of every message I send. (Claude has no clock: it only
// knows what we tell it.) The tests pass a fixed time instead of "now".
//
// Why not put it in the system prompt? Claude's thinking blocks are tied to
// everything that came before them, system prompt included. If the system
// prompt changes mid-chat (it would, every minute), the earlier thinking
// blocks no longer match and the API answers 400 "Invalid signature in
// thinking block". So the system prompt stays the same for the whole chat,
// and the conversation only ever grows at the end: old messages never change.
export function nowPrefix(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `[Now: ${date} ${pad(now.getHours())}:${pad(now.getMinutes())}, ${weekday}]`;
}

// Static: exactly the same text on every request (this also makes it cacheable later).
export const SYSTEM_PROMPT = `You are a medication assistant. You help the user keep an organised list of what their doctor prescribed.
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
- If the user says they have no known allergies, save it with update_profile using allergy_status "none_known".
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

// One tool call, as it happened (the tests check these).
export interface ToolCall {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

// What happened when I sent one message.
export interface ExchangeResult {
  ok: boolean;          // false = it broke, and my message was NOT kept
  replies: string[];    // Claude's final text answer(s)
  toolCalls: ToolCall[];
  problem?: string;     // why it wasn't ok (or a note, e.g. hit MAX_TURNS)
}

export interface SendOptions {
  now?: Date;                              // default: the real current time
  onToolCall?: (call: ToolCall) => void;   // e.g. print it as it happens
}

// Created on first use, so importing this file doesn't need an API key.
let client: Anthropic | undefined;

// A conversation is just the list of messages. The caller owns it and keeps
// passing the same list, so Claude "remembers" earlier messages.
export async function sendMessage(
  messages: Anthropic.MessageParam[],
  text: string,
  options: SendOptions = {},
): Promise<ExchangeResult> {
  client ??= new Anthropic();
  const before = messages.length;
  messages.push({ role: "user", content: `${nowPrefix(options.now)}\n${text}` });

  const result: ExchangeResult = { ok: true, replies: [], toolCalls: [] };
  try {
    await runAgentLoop(client, messages, result, options);
  } catch (err) {
    if (!(err instanceof Anthropic.APIError)) throw err; // a bug in my own code: show it
    result.ok = false;
    result.problem = `API error ${err.status}: ${err.message}`;
  }

  // A half-finished exchange would make every later call fail, so undo it.
  if (!result.ok) messages.length = before;
  return result;
}

// The inner loop: keeps calling Claude until it gives a normal answer.
async function runAgentLoop(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  result: ExchangeResult,
  options: SendOptions,
): Promise<void> {
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
        if (block.type === "text") result.replies.push(block.text);
      }
      return;
    }

    if (response.stop_reason === "tool_use") {
      // Keep Claude's full reply (including the tool_use blocks) in the conversation.
      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const toolResult = await runTool(block);
        toolResults.push(toolResult);
        const call: ToolCall = {
          name: block.name,
          input: block.input,
          result: String(toolResult.content),
          isError: toolResult.is_error === true,
        };
        result.toolCalls.push(call);
        options.onToolCall?.(call);
      }
      // All tool results go back together, in ONE user message.
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // max_tokens, refusal, etc.: don't run anything, just report it.
    result.ok = false;
    result.problem = `Stopped early: stop_reason was "${response.stop_reason}"`;
    return;
  }

  // The tool results are complete, so the conversation is still valid: keep it.
  result.problem = `Stopped after ${MAX_TURNS} turns without a final answer`;
}
