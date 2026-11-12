// Lesson 1: "Your first API call"
// Sends one message to Claude and prints the answer.
// Run it with:  npm run hello

import Anthropic from "@anthropic-ai/sdk";

// The client reads ANTHROPIC_API_KEY from the environment (our .env file).
const client = new Anthropic();

// Your plan picks Haiku for chat: fast and cheap. Change it here to compare models.
const MODEL = "claude-haiku-5-5";

const response = await client.messages.create({
  model: MODEL,
  max_tokens: 1000,
  system:
    "You are a medication assistant. You organise what the doctor prescribed. " +
    "You never give dosing advice or change treatment.",
  messages: [
    { role: "user", content: "Hi! In one sentence, what can you help me with?" },
  ],
});

// The answer comes back as a list of "content blocks". We print the text ones.
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}

// Useful for learning: how many tokens (= cost) this call used.
console.log("\nTokens used:", response.usage);
