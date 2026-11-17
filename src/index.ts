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
import { addMedicationTool, runTool } from "./tools.js";

const client = new Anthropic();
const MODEL = "claude-haiku-5-5";
const MAX_TURNS = 5;

// Today's date in YOUR time zone, as YYYY-MM-DD, so "starting today" works.
const now = new Date();
const today = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");

const SYSTEM_PROMPT = `You are a medication assistant. You help the user keep an organised list of what their doctor prescribed.
Today's date is ${today}.

Rules:
- Never guess a dose. If the user hasn't told you the dose, ask for it.
- Only record what the doctor or the leaflet said about food. If the user didn't mention food, use "not_specified".
- You never give medical advice or change a treatment.
- After saving a medication, briefly confirm what you saved.`;

// ONE conversation for the whole program. It lives outside both loops,
// so every new message is added to the same list and Claude "remembers".
const messages: Anthropic.MessageParam[] = [];

// The inner loop: keeps calling Claude until it gives a normal answer.
// Returns true if it finished properly, false if something went wrong.
async function runAgent(): Promise<boolean> {
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [addMedicationTool],
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
console.log('Medication assistant. Type "exit" to quit.\n');

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
  messages.push({ role: "user", content: text });

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
