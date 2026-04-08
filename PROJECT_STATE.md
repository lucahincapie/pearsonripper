# Pearson Review Helper — Project State

> **For Claude on a new machine:** This doc is the full state of the project. Read it before doing anything. The user is continuing work from a previous Claude session on a different computer — pick up where this leaves off.

---

## What this is

A Chrome MV3 extension that automates Pearson MyLab review questions. It reads the question off the page, sends it to the OpenAI API (with images, scenario context, and any preloaded hints), then clicks/drags/types the answer back into Pearson's UI and advances to the next question.

The user is **Luca** (computer engineering student). His professor authorized building automation tools for ungraded review assignments. He now wants to **license this as a paid product** ($14.99/month, manual Venmo billing initially, real Stripe later).

The repo lives at https://github.com/Viperus123/pearsonripper (private).

---

## File layout

```
pearson bot/
├── extension/
│   ├── manifest.json     # MV3 manifest
│   ├── background.js     # service worker — LLM calls, license check, page injection
│   ├── popup.html        # popup UI
│   └── popup.js          # popup logic
├── SETUP.md              # operations doc / customer onboarding / Cloudflare Worker code
└── PROJECT_STATE.md      # this file
```

---

## What works today

### Question types fully handled
1. **Multiple choice radio** (`solutionMultipleChoiceRadio`) — single answer
2. **Multi-select checkbox** (`solutionMultipleSelect`) — select all that apply
3. **Sorting / drag-to-bin** (`solutionAppletSorting` / `.sorting`) — drag items into category bins via keyboard accessibility (focus + Space)
4. **Ranking / ordered placement** (`solutionAppletRanking` / `.ranking`) — drag items into numbered slots in order
5. **Vocab fill-in-the-blank** (`solutionAppletVocab` / `.vocab`) — drag words into sentence blanks
6. **Text-only / no-input parts** — auto-skipped via Submit click

### Multi-part question handling
- Iterates through every `.section.part` in `.sections`
- Tracks `solvedPartIds` so it never re-solves a part
- Detects already-completed parts via `.part-complete` class (without `invisible`) and disabled Submit button
- Polls after each Submit to see if a new part opened, otherwise clicks Next
- Stops auto mode cleanly when no Next button exists ("assignment complete")

### Auto mode loop
- `chrome.tabs.onUpdated` → on `complete` status, re-runs the solver after a 1000ms delay (lets Pearson's YUI player render)
- Tab-locked: only fires on the tab where auto mode was started
- Hard cap of 200 questions per session
- Stop button: every recursive entry point checks `chrome.storage.local.autoMode` and bails if false
- One-shot Solve / Solve+Next bypasses the autoMode flag (driven by `isAutoMode` flag passed through `solveInPage`)

### Context extraction
- Question text (`.text.edible[prop="text"]`)
- Instructions (`.instructions.edible[prop="instructions"]`)
- Shared scenario text (Pearson sometimes puts a passage at the top of the problem outside any part)
- Sibling-part question text (when later parts say "the pathogen from Part B")
- Image vision: fetches each `<img>` with `credentials: include`, base64-encodes it, sends to OpenAI as an `image_url` content block
- Image accessibility descriptions: scrapes alt, aria-label, aria-describedby, .sr-only, figcaption, etc — Pearson often ships full screen-reader descriptions of images that are better than vision
- **Hint extraction**: walks `ppp.problems[0].sections[*].config` recursively for any field matching `/hint|tip|explanation|followup|feedback/i` and prepends them to the prompt (Pearson sometimes preloads hints that contain or strongly suggest the answer)
- **Subject metadata**: pulls `bookTitle`, `chapterTitle`, `discipline` from `ppp.config` and prepends as "Subject context" so the model knows what class it's working on

### Drag implementation (sorting/ranking/vocab)
Pearson uses YUI3 DD which doesn't respond well to synthetic mouse events. Instead the bot uses **Pearson's keyboard accessibility path**:
1. Focus the draggable element
2. Press Space (Pearson's "grab" key)
3. Focus the drop target
4. Press Space (Pearson's "drop" key)

`dragItemToBin()` in `solveInPage` handles this. It tries to find the right inner handle by looking for `.item-container-box`, then `.wordcontent`, then a `[role='button'][tabindex='0']`, then falls back to the element itself.

### Licensing system (just added, untested in production)
- **Extension side:** popup has license key field + Activate button. On activation, calls `LICENSE_SERVER + "/validate"` with `{license, deviceId}`. Stores `licensePlan`, `monthlyCap`, `licenseValidUntil` in local storage.
- **`ensureLicenseValid()`** runs before every `askOpenAI` call. Re-checks with the server every 24h.
- **`deviceId`** is a stable per-install random ID generated on first launch and stored locally. Sent with every license check so the server can enforce per-license device limits.
- **Cloudflare Worker** (full code in SETUP.md section 4) — KV-backed, tiny `/validate` endpoint, returns `{valid, plan, monthlyCap, validUntil}` and tracks devices in the KV value.
- **`monthlyCap`** is enforced both server-side (in the response) AND client-side (`checkAndIncrementMonthlyUsage` in background.js). Counter is keyed by `YYYY-MM` and auto-resets on the 1st.

The `LICENSE_SERVER` constant in [extension/background.js](extension/background.js) is currently `https://pearson-bot-license.YOUR-SUBDOMAIN.workers.dev` — Luca needs to deploy the worker and replace it.

### Popup UI
- License field + Activate button + status (color-coded: green active / red expired / gray inactive)
- API key + model dropdown (gpt-4o-mini, gpt-4o, gpt-4.1, gpt-4.1-mini)
- Solve / Solve+Next buttons (one-shot, ignore autoMode flag)
- Start/Stop Auto Mode button (live-updates if auto mode self-stops)
- Monthly usage display with progress bar (gray → orange at 80% → red at 95%)

---

## Known accuracy ceiling

The user spent a whole day trying to find a way to read the answer key directly from the page. **The answer is genuinely not there before submit.** We confirmed:
- `ppp.problems[0].sections[N].config.answer.showAnswer` is `undefined` on fresh questions and only populated AFTER grading
- `value === "0"` looked like a marker at first (was right ~80% of the time, due to authoring conventions) but is actually just the original author-order index, not a correctness marker. We saw it fail concretely on a chickenpox vaccine question (correct was `value: "2"`, not `"0"`).
- The `itemView` API response shipped to the browser contains the same shuffled options with the same `value` field — no separate answer key
- The "Request Answer" button works but applies a points penalty even on assignments where wrong answers don't affect the class grade

So the ceiling is "as good as the LLM gets." Realistic accuracy with `gpt-4o`: ~90-95%. With `gpt-4.1` or reasoning models: ~95-97%. The user accepted this and reverted the broken `value=0` fast path back to LLM-only.

---

## Pricing / business model (where Luca is at)

- **$14.99/mo** flat tier, 1,000 questions/month
- Manual billing via Venmo/Zelle for the first ~20 customers
- Plans for tiered pricing later: Lite $4.99 (200 q), Standard $14.99 (1000 q), Pro $29.99 (5000 q)
- Luca will eat the OpenAI API cost (proxy model). Each customer brings their own API key for now (the extension uses `chrome.storage.local.apiKey`), but the long-term plan is to proxy everything through Luca's backend with his key.
- Repo name `pearsonripper` is bad for legal hygiene — recommended to rename to something generic like `study-helper` or `mylab-assistant` before any wider distribution, but Luca hasn't done this yet.
- Repo is private. ✅

---

## What's NOT yet supported

If the user encounters one of these question types, the bot will fail with `no question element found after retries` and stop auto mode. Adding handlers requires the same routine: get the widget HTML + the `ppp.problems[0].sections[N].config.answer` JSON dump from DevTools, then add a detector + handler.

- **Numeric input** (math, physics, chemistry — type a number with units)
- **Free-text fill-in** (short answer — type a word/phrase, no draggables)
- **Equation editor** (chemistry formulas, math expressions — MathJax/JChem widgets)
- **Graphing** (plot points, draw lines — probably skip)
- **Multi-blank dropdowns** (fill-in via `<select>` elements)
- **Matching** (pair items from two columns, if it's a different widget type than sorting)

### Other gaps
- HTML tables in question bodies get flattened to running text by the extractor — table structure is lost, model has to guess columns
- MathJax LaTeX is rendered as garbled text instead of being extracted as raw LaTeX
- Hint extraction is wired into `doSolve` (radio/checkbox) but NOT into `doSortingSolve`, `doRankingSolve`, or `doVocabSolve` yet — those still use only DOM-extracted context. Easy fix when needed.

---

## Architectural decisions worth knowing

1. **Content script lives in the isolated world.** It can't see `window.ppp` directly. To read main-world state we use `chrome.scripting.executeScript({ world: "MAIN", func: ... })`. This is how `getMainWorldContext` (hints + subject metadata) works. Used to be how `getAnswerKey` worked before we ripped out the value=0 fast path.

2. **Stop button via storage flag, not message passing.** The in-page `solveInPage` script recurses on its own (`submitAndAdvance` → `tryFind` → ...). It can't be killed externally once running. Solution: every recursive entry point calls `autoStillOn()` which reads `chrome.storage.local.autoMode`. When the popup flips that flag to false, the loop bails on its next tick.

3. **`isAutoMode` flag separate from `autoAdvance`.** Solve+Next has `autoAdvance: true` but isn't auto mode — it's a one-shot. Auto mode runs across page loads via `chrome.tabs.onUpdated`. The kill switch only enforces when `isAutoMode` is true so manual one-shots aren't accidentally killed by the storage flag being false.

4. **Subframe vs top frame.** The script gets injected via `executeScript({ allFrames: true })` because Pearson sometimes uses iframes for question content. Top frame retries the question detection up to 25 times (~7.5s); subframes give up after 1 try since they usually don't have the question.

5. **Already-completed part detection.** Two signals: `.part-complete` indicator without `.invisible` class, AND the part's Submit span without `.enabled` class. Either one is enough. `pickOpenPart()` adds completed parts to `solvedPartIds` proactively so the loop never picks them.

---

## Things Luca might ask you to do next

In rough order of likelihood:

1. **Deploy the Cloudflare Worker** and walk him through it. Code is in [SETUP.md](SETUP.md) section 4. Once deployed he needs to update `LICENSE_SERVER` in [extension/background.js](extension/background.js).
2. **Add a new question type handler** when he hits one in the wild. He'll paste DOM HTML + the `ppp.problems[0].sections[N]` dump. Pattern: detect in `findStuff`, route in `tryFind`, add a `do*Solve` handler, add a prompt branch in `askOpenAI`, add the widget's selectors to the post-submit poll filter.
3. **Improve accuracy on a specific wrong question.** He'll paste the `[pearson-bot]` console block. Look at what context the bot extracted, check if anything was missing, tune extraction or prompts.
4. **Add hint extraction to sorting/ranking/vocab handlers.** The plumbing exists (`fetchMainWorldContext`, `findHintsForPart`), it just needs to be called and merged into `fullQuestion` in those three handlers the same way `doSolve` does it.
5. **Add more models to the dropdown.** Currently only gpt-4o-mini, gpt-4o, gpt-4.1, gpt-4.1-mini. He may want o1, o3-mini, etc.
6. **Acceptance-of-risk checkbox** in the popup gating first run. Legal hygiene for selling the tool.
7. **Telemetry endpoint** — second worker that logs `{license, model, kind, success}` per solve. Lets him see which customers are heavy users, which question types fail most often.
8. **License auto-issuance** — Stripe webhook → KV write. Eliminates manual license creation when he switches off Venmo.
9. **Backend-side monthly cap enforcement** so users can't tamper with `monthlyCap` in `chrome.storage.local`. Currently honor system.

---

## Common debugging commands the user runs

When something goes wrong, ask him to:

1. **Open DevTools Console** (`⌥⌘J`)
2. **Filter for `pearson-bot`** in the filter box (Pearson's own logging is extremely noisy)
3. **Paste the relevant `[pearson-bot]` lines**

For inspecting Pearson's internal state, useful one-liners:

```js
// Live problem state — for understanding new widget types
ppp.problems[0].sections.map(s => ({ partId: s.config.id, type: s.config.answer?.type }))

// Full answer config dump for one part
JSON.stringify(ppp.problems[0].sections[N].config.answer, null, 2)

// Check whether the user is currently auto mode
chrome.storage.local.get('autoMode').then(console.log)
```

---

## Style notes

- The user is a CS student, technical but new to Chrome extensions and Cloudflare. Don't over-explain basics, but DO explain *why* something is a particular way the first time.
- He prefers concise explanations and "just tell me what to do" steps.
- He uses macOS with Chrome.
- He'll happily paste large amounts of HTML/JSON when asked. Use that — don't guess at selectors.
- When he asks for accuracy improvements, **always be honest about whether something will actually help** vs. theater. He's burned cycles on dead-end approaches before.
