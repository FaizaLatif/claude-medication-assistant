# Learning Guide: Medication Assistant

My step-by-step path from "empty folder" to the finished portfolio project.
Each step follows one Claude Platform 101 lesson. Tick the boxes as I go.

---

## 1. What is in this project (and why)

```
claude-medication-assistant/
├── src/
│   └── hello.ts          ← my code (TypeScript). First program: one API call
├── data/                 ← my medication data (JSON) will live here
│   └── .gitkeep          ← empty file so Git keeps the folder
├── docs/
│   └── LEARNING_GUIDE.md ← this file
├── node_modules/         ← installed packages (never edit, never commit)
├── .env                  ← MY SECRET API KEY (never commit, never share)
├── .env.example          ← template showing what goes in .env (safe to commit)
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

### How `npm run hello` works

1. npm looks in `package.json` → `scripts.hello` → `tsx --env-file=.env src/hello.ts`
2. `--env-file=.env` loads my API key into the environment.
3. `tsx` runs `src/hello.ts`.
4. `new Anthropic()` finds the key automatically.
5. `client.messages.create(...)` sends **model + system prompt + messages** to Claude.
6. Claude answers with a list of **content blocks**; I print the `text` ones.
7. `usage` tells me tokens in/out, which is what I pay for.

### Key vocabulary

- **System prompt**: standing instructions for Claude ("you never give dosing advice").
- **Messages**: the conversation so far, a list of `{ role: "user" | "assistant", content }`.
  Claude has **no memory**: I send the whole conversation every time.
- **Tokens**: small pieces of text (~¾ of a word). Cost = input tokens + output tokens.
- **Tool**: a function *my code* runs when Claude asks for it (e.g. `add_medication`).
  Claude never touches my files directly. It *asks*, my code *does*.
- **Agent loop**: send message → Claude asks for a tool → I run it → send result back → repeat until Claude answers normally.

---

## 2. Everyday commands (Git Bash)

```bash
cd ~/Documents/Projects/claude-medication-assistant   # go to the project

npm run hello        # run my first program
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

Legend: ✅ done · ⬜ to do

### Phase 0: Setup

- ✅ **Step 0: Project setup.** Node project, SDK, Zod, TypeScript, `.env`, first API call works.
- ⬜ **Step 1: First Git commit.**
  - Learn: `git status`, `git add`, `git commit`, `git push`.
  - Check `.env` is **not** in the list before committing.
  - Done when: GitHub shows the files, and `.env` is not there.

### Phase 1: Core assistant (terminal app + JSON files)

- ⬜ **Step 2: The data model** *(no API yet)*
  - Create `src/schema.ts`: a Zod schema for a medication entry:
    name, dose, schedule (time slots *or* every N hours), start date, end date,
    with food?, reason, prescriber, status (`active` / `stopped`), stop reason.
  - Create `src/storage.ts`: read/write `data/medications.json`.
  - Learn: Zod, types, reading/writing JSON files.
  - Done when: a small script saves one fake medicine and reads it back.

- ⬜ **Step 3: Lesson "Your first API call" (part 2): ask about my list**
  - Load the saved list and put it in the prompt; ask "What am I taking?"
  - Learn: giving Claude context, why answers must come *only* from the data.
  - Done when: Claude answers correctly and says "I don't know" for things not in the list.

- ⬜ **Step 4: Lesson "The agent loop + tool use": manual loop**
  - Build a terminal chat (`src/chat.ts`, `npm run chat`) that keeps the conversation.
  - Add the first tool: **`add_medication`** with `strict: true`.
  - Write the loop myself: `stop_reason === "tool_use"` → run tool → send `tool_result`.
  - System prompt: ask **one** clarifying question at a time; never guess a dose.
  - Done when: "Brufen 400 every 6 hours for 4 days, starting today" → saved entry with correct end date.

- ⬜ **Step 5: More tools**
  - `stop_medication` (status + date + reason, never delete)
  - `get_profile` (allergies, notes)
  - `get_schedule` (Morning / Lunch / Evening / Bedtime + intervals). "What do I take now?" uses the **current time from my code**, not Claude's guess.
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

-
