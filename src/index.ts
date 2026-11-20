// The chat in the terminal. Run it with:  npm start   (type "exit" to quit)
//
// Two loops:
//   OUTER loop (here): read what I type -> sendMessage() -> print -> repeat.
//   INNER loop (the agent loop, in agent.ts): call Claude, run tools, repeat
//   until Claude gives a final answer.
// The automated tests (tests/run.ts) use the same sendMessage(), with
// scripted messages instead of the keyboard.

import type Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SYSTEM_PROMPT, sendMessage, type ToolCall } from "./agent.js";
import { tools } from "./tools.js";

// ONE conversation for the whole program, so Claude "remembers".
const messages: Anthropic.MessageParam[] = [];

function printToolCall(call: ToolCall): void {
  console.log(`  [tool call] ${call.name}`, JSON.stringify(call.input));
  console.log(call.isError ? "  [tool ERROR]" : "  [tool result]", call.result);
}

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

  const result = await sendMessage(messages, text, { onToolCall: printToolCall });
  for (const reply of result.replies) console.log(`\nAssistant: ${reply}\n`);
  if (!result.ok) {
    console.log(`\n(${result.problem}. That message was not kept. Please try again.)\n`);
  } else if (result.problem) {
    console.log(`\n(${result.problem}.)\n`);
  }
}

rl.close();
console.log("Bye!");
