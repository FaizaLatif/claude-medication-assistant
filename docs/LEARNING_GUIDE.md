# Learning Guide: Medication Assistant

My step-by-step path from "empty folder" to the finished portfolio project.
Each step follows one Claude Platform 101 lesson. Tick the boxes as I go.

---

## 1. What is in this project (and why)

```
claude-medication-assistant/
├── src/                  ← my code (TypeScript)
│   ├── index.ts          ← the program: system prompt + chat loop + my hand-written agent loop
│   ├── tools.ts          ← the 5 tool definitions + the code that runs them
│   └── storage.ts        ← reads/writes data/medications.json and data/settings.json
├── data/                 ← my medication data (JSON) lives here (Git ignores the .json files)
│   ├── .gitkeep          ← empty file so Git keeps the folder
│   ├── medications.json  ← my medicines, created on the first run
│   └── settings.json     ← my usual times (morning 08:00, ...), created on the first run
├── docs/
│   └── LEARNING_GUIDE.md ← this file
├── node_modules/         ← installed packages (never edit, never commit)
├── .env                  ← MY SECRET API KEY (never commit, never share)
├── .env.example          ← (not created yet) template showing what goes in .env (safe to commit)
├── .gitignore            ← list of files Git must ignore
├── package.json          ← project "ID card": name, packages, shortcut scripts
├── package-lock.json     ← exact versions installed (commit it, never edit)
├── tsconfig.json         ← settings for the TypeScript checker
└── README.md             ← public description of the project
```

### The pieces, in plain words

| Piece | What it is | Analogy |
|---|---|---|
| **Node.js** | Runs JavaScript/TypeScript on my computer (outside a browser) | The engine |
| **npm** | Downloads packages and runs scripts | The app store |
| **TypeScript** | JavaScript plus types: catches mistakes *before* running | Spell-checker for code |
| **tsx** | Runs `.ts` files directly, no build step | "Play" button |
| **@anthropic-ai/sdk** | Official library for talking to the Claude API | The phone line to Claude |
| **Zod** | Describes the *shape* of data ("dose is a string, required") and checks it | A form template |
| **.env** | File with secrets, loaded when the program starts | A locked drawer |
| **Git** | Saves snapshots of my project over time | Save points in a game |

### How `npm start` works

1. npm looks in `package.json` → `scripts.start` → `tsx --env-file=.env src/index.ts`
2. `--env-file=.env` loads my API key into the environment.
3. `tsx` runs `src/index.ts`.
4. `new Anthropic()` finds the key automatically.
5. `client.messages.create(...)` sends **model + system prompt + tools + messages** to Claude.
6. Claude answers with a list of **content blocks** (`text`, `tool_use`, ...) and a **`stop_reason`**.
7. `usage` tells me tokens in/out, which is what I pay for.

### How my two loops work (`src/index.ts`)

```
messages = []                         ← ONE conversation for the whole program

OUTER loop (the chat):
    read "You: ..."                   ← "exit" quits, empty line is skipped
    push it to messages
    run the INNER loop

INNER loop (the agent loop), max 5 turns:
    response = send(system prompt with current date+time, tools, messages)
    if stop_reason == "end_turn"  → print "Assistant: ...", back to the chat
    if stop_reason == "tool_use"  → run each tool, send ALL results back in ONE user message, loop again
    anything else (max_tokens, refusal) → stop and say why
```

- **One `messages` array, outside both loops** = Claude "remembers" the whole chat.
  It has no memory of its own: I resend everything each time (so long chats cost more per message).
- **Max 5 turns** is a safety net so a confused loop can't run (and cost money) forever.
- I push Claude's **whole** `response.content`, not just the text, so it remembers its own tool calls.
- Each `tool_result` has the same `tool_use_id` as the call it answers.
- If my tool fails, I send back `is_error: true` with the reason. Claude can then fix the input or tell me.
- **Undo a broken exchange**: if the API fails or Claude stops oddly, I cut `messages` back to where it was
  before my message. A `tool_use` without its `tool_result` would make every later request fail.
- **The system prompt is a function**, rebuilt before every request, so the date and time are never stale.

### How the tools work (`src/tools.ts`)

| Tool | What it does | Input |
|---|---|---|
| `add_medication` | Saves a **new** medicine (only after I confirm a one-line summary) | all fields (some may be `null`) |
| `list_medications` | Lists medicines **with their ids**, so Claude can find "the Brufen" | optional `status`: `current` (default) / `stopped` / `all` |
| `update_medication` | Fixes a mistake | `id` + **only** the fields that change |
| `stop_medication` | Marks as stopped. **Never deletes** | `id`, `stop_date`, `stop_reason` (all required) |
| `get_schedule` | What I take on one day, sorted by time | `date` |

Every tool has the same three parts:

1. **Definition** (sent to Claude): name, description, JSON schema with `strict: true`.
2. **Second check** (my code): Zod checks rules strict mode can't:
   - `every_hours` 1–24, `first_dose_time` is a real `HH:MM`
   - timing fields match `timing_type` (e.g. `every_hours` must be `null` unless it's `every_x_hours`).
     This stops a correction leaving a medicine "half one way, half the other".
3. **My code does the work**: adds `id`, `status`, `end_date`, saves, calculates the schedule.

Details worth remembering:

- **`end_date`** = the **last day** I take it: start + duration − 1.
  "4 days from 17 Nov" → 17, 18, 19, 20 → `end_date: 2026-11-20`. Ongoing → `null`.
  `update_medication` recalculates it when `start_date` or `duration_days` change.
- **`update_medication`: left out vs `null`.** A field I leave out stays the same; a field set to `null` is cleared.
  It can't change `id` or `status` (Zod drops fields that aren't medicine fields).
- **`stop_medication`** refuses if it's already stopped, or if the stop date is before the start date.
- **`get_schedule`** only includes `current` medicines active that day (`start_date ≤ day ≤ end_date`):
  - `times_of_day` → the slot's clock time from `data/settings.json` (morning → 08:00).
  - `every_x_hours` → counted from `first_dose_time` on the start date, **carrying on across midnight**.
    Every 8 h from 10:00 → day 1: 10:00, 18:00 · day 2: 02:00, 10:00, 18:00.
    Every 5 h doesn't divide 24, so the times shift each day.
  - `when_needed` → a separate `if_needed` list.
  - `every_x_hours` with no `first_dose_time` → a `first_dose_time_unknown` list, so Claude asks me.
- **Older saved entries** don't have the new fields (`first_dose_time`, `stop_date`, `stop_reason`).
  That's why they're optional (`?`) in the `Medication` type in `storage.ts`.

### Key vocabulary

- **System prompt**: standing instructions for Claude ("you never give dosing advice").
- **Messages**: the conversation so far, a list of `{ role: "user" | "assistant", content }`.
  Claude has **no memory**: I send the whole conversation every time.
- **Tokens**: small pieces of text (~¾ of a word). Cost = input tokens + output tokens.
- **Tool**: a function *my code* runs when Claude asks for it (e.g. `add_medication`).
  Claude never touches my files directly. It *asks*, my code *does*.
- **Agent loop**: send message → Claude asks for a tool → I run it → send result back → repeat until Claude answers normally.
- **Strict tool**: `strict: true` guarantees Claude's tool input matches my JSON schema.

---

## 2. Everyday commands (Git Bash)

```bash
cd ~/Documents/Projects/claude-medication-assistant   # go to the project

npm start            # run the assistant (uses the API = costs a little). Type "exit" to quit.
npm run typecheck    # check my code for type errors (no API call, free)
npm install          # re-install packages (e.g. after cloning on a new PC)

git status           # what changed?
git add .            # stage all changes
git commit -m "..."  # save a snapshot with a message
git push             # upload to GitHub
git log --oneline    # list of my snapshots
```

---

## 3. Rules I never break

1. **Never commit or share `.env`.** I only tell Claude "I updated .env", never the key.
2. **My real medication data stays in `data/`**, which Git ignores. Tests use *fictional* data.
3. **The assistant never guesses a dose** and never gives medical advice. It only organises what the doctor said.
4. **Nothing is deleted**: stopping a medicine sets `status: "stopped"` with a date and reason.
5. **Commit after every step that works.** Small commits = easy to undo.
6. **Run `npm run typecheck` before committing.**

---

## 4. The roadmap

Legend: ✅ done · 🟡 in progress · ⬜ to do

> **Numbering note:** in my chat with Claude Code I numbered the work differently. My "Step 3: chat loop"
> is part of roadmap Step 4 below, my "Step 4: find, correct and stop" and "Step 5: daily schedule" are
> roadmap Step 5.

### Phase 0: Setup

- ✅ **Step 0: Project setup.** Node project, SDK, Zod, TypeScript, `.env`, first API call works.
  - Later renamed `hello.ts` → `index.ts` and `npm run hello` → `npm start`.
- ✅ **Step 1: First Git commit.**
  - Learn: `git status`, `git add`, `git commit`, `git push`.
  - Check `.env` is **not** in the list before committing.
  - Done when: GitHub shows the files, and `.env` is not there.

### Phase 1: Core assistant (terminal app + JSON files)

- 🟡 **Step 2: The data model**
  - ✅ `src/storage.ts`: read/write `data/medications.json` (creates the folder + `[]` if missing).
  - ✅ Zod schema for a medication. It lives in `src/tools.ts` for now, not in a separate `src/schema.ts`.
    Fields: name, dose, timing (`times_of_day` / `every_x_hours` / `when_needed`), first dose time,
    with food, start date, duration → end date, reason.
  - ✅ Status is `"current"` / `"stopped"` (decided: not `"active"`), plus `stop_date` and `stop_reason`.
  - ✅ `data/settings.json` with my usual times for each part of the day.
  - ⬜ Still missing from the plan: **prescriber**.
  - Learn: Zod, types, reading/writing JSON files.

- 🟡 **Step 3: Lesson "Your first API call" (part 2): ask about my list**
  - Done differently: instead of pasting the list into the prompt, Claude calls **`list_medications`** to read it.
  - ⬜ Test: "What am I taking?" is correct, and it says "I don't know" for things not in the list.
  - Learn: giving Claude context, why answers must come *only* from the data.

- 🟡 **Step 4: Lesson "The agent loop + tool use": manual loop** *(done early, before Step 3)*
  - ✅ First tool: **`add_medication`** with `strict: true` + Zod double-check (`src/tools.ts`).
  - ✅ Loop written by hand in `src/index.ts`: `client.messages.create` + `stop_reason` checks, max 5 turns.
  - ✅ System prompt has the date, "never guess a dose", "only record what the doctor/leaflet said about food".
  - ✅ Real terminal chat (`node:readline/promises`) that keeps the conversation.
    It's in `src/index.ts` / `npm start`, not a separate `src/chat.ts` / `npm run chat`.
  - ✅ Before saving, Claude shows a one-line summary and asks me to confirm.
  - ⬜ System prompt: ask **one** clarifying question at a time.
  - ⬜ Test: "Brufen 400 every 6 hours for 4 days, starting today" → saved entry with correct end date.

- 🟡 **Step 5: More tools**
  - ✅ `list_medications` (with ids, filter by status)
  - ✅ `update_medication` (only the changed fields; recalculates `end_date`)
  - ✅ `stop_medication` (status + date + reason, never delete)
  - ✅ `first_dose_time` for `every_x_hours` medicines; Claude asks for it when it's missing.
  - ✅ `get_schedule` (Morning / Lunch / Evening / Bedtime + intervals, sorted by time).
    "What do I take now?" uses the **current date and time from my code**, not Claude's guess.
  - ⬜ `get_profile` (allergies, notes)
  - ⬜ Test it in the chat (see the test list in my Step 4/5 notes below), then commit.
  - Done when: user stories 1, 2 and 3 from the business case work.

- ⬜ **Step 6: Switch to Tool Runner + Zod**
  - Replace my hand-written loop with `client.beta.messages.toolRunner(...)` and `betaZodTool(...)`.
  - Learn: what the SDK does for me, and why I wrote it by hand first.
  - Done when: same behaviour, less code.

- ⬜ **Step 7: Test set (my "eval")**
  - `tests/sentences.json`: 20 **fictional** sentences (simple / missing info / ambiguous) + expected result.
  - `npm run eval` runs them all and prints a score.
  - Targets: **18/20 correct**, **0 guessed doses**, **≤ 3 messages** per medicine.
  - Run it after every change from now on.

- ⬜ **Step 8: Lesson "Choosing the right model"**
  - Run the eval with `claude-haiku-5-5` vs `claude-sonnet-5-5`.
  - Compare: score, speed, cost (from `usage`). Write the results in a table here.

- ⬜ **Step 9: Lesson "What is thinking?"**
  - Hard cases: "every 6 hours for 4 days", "max 3 a day", "only on Mondays".
  - Try different `output_config.effort` levels and see if the eval score changes.

- ⬜ **Step 10: Exports and reminders**
  - `export_history`: family summary (current meds) + doctor history (dates, reason stopped, allergies).
  - `create_reminders`: write an `.ics` file, one event per dose; import it on my phone.
  - Done when: user stories 4, 5 and 6 work.

### Phase 2: Platform features

- ⬜ **Step 11: Lesson "Built-in tools"**
  - Web search limited to official medicine sources (`allowed_domains`), for leaflet info, **not** advice.
  - Code execution for date and schedule calculations.
- ⬜ **Step 12: Lesson "Skills"**
  - A Skill that defines the exact format of the family export and the doctor history.
- ⬜ **Step 13: Lesson "MCP"**
  - Connect a calendar MCP server so reminders go straight into my calendar (instead of `.ics`).

### Phase 3: Scaling up

- ⬜ **Step 14: Lesson "Context management"**: keep long chats small and cheap (caching, compaction).
  - Remember: my system prompt changes every minute (current time), which stops it being cached.
    Move the time somewhere else first.
- ⬜ **Step 15: Lesson "Managed agents"**: weekly review agent that flags medicines ending soon.

### Phase 4: Ship it

- ⬜ **Step 16: Lesson "Building with Claude Code"**: small web app, usable from the phone ("Add to home screen").
- ⬜ **Step 17: Beyond the course**: add a medicine from a photo/PDF of a prescription, always with a confirmation step.
- ⬜ **Step 18: Showcase**
  - Replace the API key before publishing.
  - Talk to 5 people who manage medicines (target: 3 say "I'd use this").
  - Record a demo video, polish the README, publish the LinkedIn post.

---

## 5. How I work with Claude Code (to actually learn)

- Ask for **one step at a time**, and ask "explain what this does" before accepting code.
- Try to write small changes myself first, then ask Claude to review them.
- After each step: run it, run `npm run typecheck`, then commit.
- When something breaks, paste the **error message** (never the key) and ask *why*, not just "fix it".
- Update this guide: tick the box ✅ and add notes on what I learned.

## 6. My notes

*(What I learned, surprises, model comparison results...)*

- **Strict mode has limits.** `strict: true` guarantees the *shape* of Claude's input, but it doesn't
  support `minimum` / `maximum` / `minLength`. So "1–24 hours" goes in the description, and Zod checks it in my code.
- **Optional vs nullable in strict mode** *(corrected in Step 4)*. Fields left out of `required` are
  **optional** (max 24 per request across all strict tools). `type: ["integer", "null"]` makes a field
  **nullable** (max 16 per request). `update_medication` uses both: left out = "don't change", `null` = "clear it".
  Every object needs `additionalProperties: false`.
- **Claude doesn't know the date or time** unless I tell it. The system prompt includes both, in local time
  (not UTC, or "today" can be wrong late at night), rebuilt before every request.
- **Claude asks, my code does.** Claude only *proposes* the tool input; my code adds the `id`, `status`
  and `end_date`, does the saving, and calculates the schedule. Calculations I can do in code, I don't leave to the model.
- **Claude must look up ids, never invent them.** The prompt says "call `list_medications` first", and a wrong id
  returns an error that tells Claude to do exactly that.
- **A tool error isn't a crash.** `is_error: true` lets Claude read the problem and try again.
- **Changing the data model later is normal.** New fields are optional so old saved entries still work.
- **Git works in Git Bash**, not in PowerShell (it isn't on the PowerShell PATH).

### Chat tests for Steps 4 and 5 (run with `npm start`)

| I type | I should see |
|---|---|
| `I take Brufen 400 mg every 6 hours for 4 days from today, for a toothache.` | A summary + "confirm?" and **no** tool call yet. It may also ask for the first dose time. |
| `yes` | `add_medication` |
| `Sorry, the doctor said 5 days.` | `list_medications` → `update_medication` with only `duration_days`; `end_date` moves 1 day |
| `What do I take now?` | `get_schedule` for today → what's due within ~1 hour + what's next |
| `I stopped the Brufen.` | It asks why (and when) **before** `stop_medication` |
| `I take paracetamol every 8 hours.` | It asks for the **dose**, never guesses |
| `Delete the Brufen.` | It says it can't delete, offers to stop it instead |
