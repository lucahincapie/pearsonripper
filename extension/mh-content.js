// ============================================================
// MH Recharge Helper — content script (isolated world)
// ============================================================
// Responsibilities:
//   1. Inject injected.js into the page's main world ASAP so it can
//      hook fetch/XHR before Angular makes any calls.
//   2. Listen for cached question entries broadcast by the main-world
//      script via postMessage.
//   3. Watch the DOM for rendered questions and click the right answer
//      when one appears, optionally hitting Submit/Next.
// ============================================================

(() => {
  const TAG = "[mhrh-cs]";
  const log = (...a) => console.log("%c" + TAG, "color:#06c;font-weight:bold", ...a);

  // -------- inject main-world script ----------------------------------
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (e) {
    log("inject failed", e);
  }

  // -------- local cache mirror ----------------------------------------
  // stemNorm -> entry (same shape as serializeEntry in injected.js)
  const cache = new Map();

  function normalizeText(s) {
    if (!s) return "";
    return String(s)
      .replace(/\$\{response:[^}]+\}/g, " ") // FITB placeholders
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/_+/g, " ") // visible blank underscores
      .replace(/\bblank\b/gi, " ") // _visuallyHidden "Blank" word
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || !m.__mhrh) return;
    if (m.kind === "item" && m.entry) {
      cache.set(m.entry.stemNorm, m.entry);
      // Try to solve immediately in case the question is already on screen
      tryAutoSolve("cache update");
    }
  });

  // -------- DOM helpers -----------------------------------------------
  function findPromptEl() {
    return (
      document.querySelector(".prompt") ||
      document.querySelector('[id^="testing_group_"]')
    );
  }

  function getCurrentStem() {
    const el = findPromptEl();
    if (!el) return null;
    return { el, text: el.textContent || "", norm: normalizeText(el.textContent || "") };
  }

  function getChoiceRows() {
    return [...document.querySelectorAll(".choice-row")];
  }

  function getChoiceText(row) {
    const t = row.querySelector(".choiceText");
    return t ? t.textContent || "" : row.textContent || "";
  }

  function findCorrectRow(entry) {
    const matches = findCorrectRows(entry);
    return matches[0] || null;
  }

  function findCorrectRows(entry) {
    const rows = getChoiceRows();
    if (rows.length === 0) return [];
    const out = [];
    const usedRows = new Set();
    for (const want of entry.correctTexts) {
      // Exact match first
      let hit = rows.find(
        (r) => !usedRows.has(r) && normalizeText(getChoiceText(r)) === want
      );
      if (!hit) {
        // Substring fallback
        hit = rows.find((r) => {
          if (usedRows.has(r)) return false;
          const norm = normalizeText(getChoiceText(r));
          return norm.includes(want) || want.includes(norm);
        });
      }
      if (hit) {
        usedRows.add(hit);
        out.push(hit);
      }
    }
    return out;
  }

  function clickRow(row) {
    if (!row) return false;
    const radio = row.querySelector('input[type="radio"], input[type="checkbox"]');
    const label = row.querySelector("label");
    const target = radio || label || row;
    target.click();
    // Some Angular forms only react to a real change event
    if (radio) {
      radio.dispatchEvent(new Event("input", { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  function findFillBlankInputs() {
    // Recharge inlines blanks as <input class="fitb-input"> inside .prompt.
    // Returns inputs in DOM order so we can pair them with entry.blanks.
    const p = findPromptEl();
    if (!p) return [];
    const fitb = [...p.querySelectorAll("input.fitb-input")];
    if (fitb.length) return fitb;
    return [
      ...p.querySelectorAll(
        'input[type="text"], input:not([type]), input[type="search"]'
      ),
    ];
  }

  function fillBlank(input, text) {
    if (!input || text == null) return false;
    // Use the prototype setter so React/Angular detect the change.
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function findConfidenceButton(level) {
    // Recharge has High / Medium / Low buttons with stable data-automation-ids.
    const want = (level || "high").toLowerCase();
    const sel = `button[data-automation-id="confidence-buttons--${want}_confidence"]`;
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) return btn;
    // Fallback: text match
    const btns = [...document.querySelectorAll("button")].filter((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t === want;
    });
    return btns.find((b) => !b.disabled) || null;
  }

  function findSubmitButton() {
    const btns = [...document.querySelectorAll("button")];
    return (
      btns.find((b) => /^submit$/i.test((b.textContent || "").trim()) && !b.disabled) ||
      null
    );
  }

  function findNextButton() {
    // Recharge uses .next-button on the primary advance button.
    const byClass = document.querySelector("button.next-button");
    if (byClass && !byClass.disabled) return byClass;
    const btns = [...document.querySelectorAll("button")];
    return (
      btns.find(
        (b) =>
          /^(next( question)?|continue)$/i.test((b.textContent || "").trim()) &&
          !b.disabled
      ) || null
    );
  }

  // -------- solver ----------------------------------------------------
  let solvedThisRender = false;
  let lastStemNorm = null;
  let lastSolveTime = 0;
  let contextDead = false;
  let solveInFlight = false;
  let currentEntryType = null;

  async function setStatus(state, detail) {
    if (contextDead) return;
    try {
      await chrome.storage.local.set({
        status: { state, detail: detail || "", at: Date.now() },
      });
    } catch {
      contextDead = true;
    }
  }

  async function tryAutoSolve(reason) {
    if (contextDead) return;
    if (solveInFlight) {
      // Remember that someone wanted us — re-check after the in-flight
      // solve releases the lock, in case a new question loaded mid-flight.
      solveQueued = true;
      return;
    }
    solveInFlight = true;
    try {
      await tryAutoSolveInner(reason);
    } finally {
      solveInFlight = false;
      if (solveQueued) {
        solveQueued = false;
        // Defer one tick so the DOM has a chance to settle.
        setTimeout(() => tryAutoSolve("queued"), 200);
      }
    }
  }
  let solveQueued = false;

  async function tryAutoSolveInner(reason) {
    if (contextDead) return;
    let settings;
    try {
      settings = await chrome.storage.local.get([
        "enabled",
        "autoSubmit",
        "confidence",
        "humanlike",
        "license",
        "licenseValidUntil",
      ]);
    } catch (e) {
      // Extension was reloaded — this content script is stale. Stop everything.
      contextDead = true;
      try { obs.disconnect(); } catch {}
      return;
    }
    if (settings.enabled === false) {
      setStatus("stopped", "Stopped");
      return;
    }
    // License gate — must have a valid key. Master key always passes.
    if (
      !settings.license ||
      (settings.license !== "COURSEPILOT-DEV-FOREVER" &&
        (!settings.licenseValidUntil || settings.licenseValidUntil < Date.now()))
    ) {
      setStatus("stopped", "Inactive — activate license to use");
      return;
    }

    const stem = getCurrentStem();
    if (!stem || !stem.norm) {
      setStatus("idle", "No question on screen");
      return;
    }

    // Reset the solved flag whenever the stem changes OR enough time has
    // passed that the question must have advanced (5s is plenty since the
    // confidence+next chain takes ~1s).
    const now = Date.now();
    if (stem.norm !== lastStemNorm || now - lastSolveTime > 5000) {
      lastStemNorm = stem.norm;
      solvedThisRender = false;
    }
    if (solvedThisRender) return;

    const entry = cache.get(stem.norm);
    if (!entry) {
      setStatus("waiting", "Waiting for question data…");
      maybeAutoRecover(stem.norm);
      return;
    }

    log("solving:", stem.text.slice(0, 80), "(reason:", reason + ")");
    currentEntryType = entry.type;
    setStatus("solving", stem.text.slice(0, 80));

    let clicked = false;
    const isFITB =
      entry.type === "FILL_IN_THE_BLANK" ||
      entry.type === "FILL_IN_BLANK" ||
      (entry.blanks && entry.blanks.length && !entry.correctTexts.length);
    const isOrdering = entry.type === "ORDERING" || (entry.orderedKeys && entry.orderedKeys.length);
    const isMatching = entry.type === "MATCHING" || (entry.matching && entry.matching.promptToChoice);

    if (isMatching) {
      const ok = await solveMatching(entry);
      if (ok) {
        clicked = true;
        log("matching applied");
      } else {
        log("matching failed");
      }
    } else if (isOrdering) {
      const ok = await solveOrdering(entry);
      if (ok) {
        clicked = true;
        log("ordering applied");
      } else {
        log("ordering failed");
      }
    } else if (isFITB) {
      const inputs = findFillBlankInputs();
      const blanks = entry.blanks || [];
      if (inputs.length === 0) {
        log("no input element found for FITB");
      } else if (blanks.length === 0) {
        log("no blank answers in cache entry");
      } else {
        // Pair inputs to blanks in DOM order. If counts differ, fill the
        // shorter of the two.
        const n = Math.min(inputs.length, blanks.length);
        for (let i = 0; i < n; i++) {
          fillBlank(inputs[i], blanks[i].primary);
          log("filled blank " + i + ":", blanks[i].primary);
        }
        clicked = true;
      }
    } else if (entry.correctTexts.length > 1 || entry.type === "MULTIPLE_CHOICE_MULTI_SELECT" || entry.type === "MULTI_SELECT") {
      const matches = findCorrectRows(entry);
      if (matches.length) {
        for (const row of matches) {
          clickRow(row);
          log("clicked:", normalizeText(getChoiceText(row)));
        }
        clicked = matches.length === entry.correctTexts.length;
        if (!clicked) log("only matched", matches.length, "of", entry.correctTexts.length);
      } else {
        log("no matching choice rows found for", entry.correctTexts);
      }
    } else if (entry.type === "MULTIPLE_CHOICE" || entry.correctTexts.length) {
      const row = findCorrectRow(entry);
      if (row) {
        clickRow(row);
        clicked = true;
        log("clicked:", normalizeText(getChoiceText(row)));
      } else {
        log("no matching choice row found for", entry.correctTexts);
      }
    }

    if (!clicked) return;
    solvedThisRender = true;
    lastSolveTime = Date.now();

    bumpStat();

    if (settings.autoSubmit !== false) {
      const human = settings.humanlike !== false;
      // Wait a beat after answering. Humanlike: 1.4–3.2s, fixed: 700ms.
      await sleep(human ? jitter(1400, 3200) : 700);
      await waitAndClick(
        () => findConfidenceButton(settings.confidence || "high"),
        "confidence",
        300,
        20
      );
      await sleep(human ? jitter(500, 1100) : 400);
      const sub = findSubmitButton();
      if (sub) {
        sub.click();
        log("submit clicked");
        await sleep(human ? jitter(400, 900) : 400);
      }
      // After confidence/submit, Recharge renders the scoring view with
      // correct/incorrect icons. Poll briefly to read the verdict.
      await checkCorrectness();
      await waitAndClick(() => findNextButton(), "next", 300, 30);
    }
  }

  function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  // -------- auto-recover for missing-cache stalls --------
  // Recharge sometimes reuses an in-memory question without re-fetching
  // its JSON from the CDN. When that happens our cache misses and the
  // bot stalls. We track how long we've been stuck on a single stem,
  // and if it's been >8s without progress, force a hard reload of the
  // tab. The fresh load triggers Recharge to re-request the JSON which
  // our hook intercepts.
  let stuckStem = null;
  let stuckSince = 0;
  let lastReloadAt = 0;
  function maybeAutoRecover(stemNorm) {
    const now = Date.now();
    if (stemNorm !== stuckStem) {
      stuckStem = stemNorm;
      stuckSince = now;
      return;
    }
    if (now - stuckSince < 8000) return;
    // Don't reload more than once every 30s — avoid loops
    if (now - lastReloadAt < 30_000) return;
    lastReloadAt = now;
    log("auto-recover: cache miss after 8s, hard reloading tab");
    setStatus("waiting", "Auto-recovering…");
    location.reload();
  }

  async function checkCorrectness() {
    // Recharge renders <span class="correct -icon"> or <span class="incorrect -icon">
    // inside .correctness wrappers after a question is graded.
    for (let i = 0; i < 15; i++) {
      const correct = document.querySelectorAll(".correctness .correct").length;
      const incorrect = document.querySelectorAll(".correctness .incorrect").length;
      if (correct + incorrect > 0) {
        const wasCorrect = incorrect === 0;
        log("graded:", wasCorrect ? "CORRECT" : "WRONG", `(${correct} correct, ${incorrect} incorrect)`);
        await bumpAccuracy(wasCorrect);
        return;
      }
      await sleep(150);
    }
    log("graded: no verdict element found");
  }

  async function bumpAccuracy(wasCorrect) {
    if (contextDead) return;
    try {
      const data = await chrome.storage.local.get([
        "gradedTotal",
        "gradedCorrect",
        "perType",
        "recentActivity",
      ]);
      const gradedTotal = (data.gradedTotal || 0) + 1;
      const gradedCorrect = (data.gradedCorrect || 0) + (wasCorrect ? 1 : 0);
      const perType = data.perType || {};
      const t = currentEntryType || "UNKNOWN";
      perType[t] = perType[t] || { total: 0, correct: 0 };
      perType[t].total += 1;
      if (wasCorrect) perType[t].correct += 1;

      const recent = (data.recentActivity || []).slice(-19);
      const stem = lastStemNorm || "";
      recent.push({
        ok: wasCorrect,
        type: t,
        stem: stem.slice(0, 80),
        at: Date.now(),
      });

      await chrome.storage.local.set({
        gradedTotal,
        gradedCorrect,
        perType,
        recentActivity: recent,
      });
    } catch {
      contextDead = true;
    }
  }

  // -------- ordering solver -------------------------------------------
  // react-beautiful-dnd ships keyboard accessibility: focus a draggable,
  // press Space to lift, ArrowDown/ArrowUp to move, Space to drop.
  // We perform a selection sort: place position 0 first, then 1, etc.

  function getOrderingItems() {
    return [...document.querySelectorAll('.choice-item[id^="choices:"]')];
  }

  function getOrderingKey(el) {
    if (!el) return null;
    const id = el.id || "";
    const m = id.match(/^choices:(.+)$/);
    return m ? m[1] : null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // react-beautiful-dnd's keyboard sensor checks event.key, event.keyCode,
  // and that the event target is the drag handle. It also requires the
  // event NOT have its default prevented before reaching its handler.
  // We dispatch with full property bag and target both element and document.
  function fireKey(el, key, code, keyCode) {
    const init = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };
    const down = new KeyboardEvent("keydown", init);
    // Some libraries read keyCode/which off the prototype after construction
    Object.defineProperty(down, "keyCode", { get: () => keyCode });
    Object.defineProperty(down, "which", { get: () => keyCode });
    el.dispatchEvent(down);
    const up = new KeyboardEvent("keyup", init);
    Object.defineProperty(up, "keyCode", { get: () => keyCode });
    Object.defineProperty(up, "which", { get: () => keyCode });
    el.dispatchEvent(up);
  }

  async function moveItem(el, steps) {
    el.focus();
    // Click the element first — react-beautiful-dnd binds its keyboard
    // sensor on focused drag handles, but the focus must be from an
    // actual interaction or it won't register the lift.
    el.click();
    await sleep(200);
    // Lift with Space (keyCode 32)
    fireKey(el, " ", "Space", 32);
    await sleep(300);
    const isDown = steps > 0;
    const key = isDown ? "ArrowDown" : "ArrowUp";
    const code = key;
    const keyCode = isDown ? 40 : 38;
    const n = Math.abs(steps);
    for (let i = 0; i < n; i++) {
      fireKey(el, key, code, keyCode);
      await sleep(220);
    }
    // Drop with Space
    fireKey(el, " ", "Space", 32);
    await sleep(400);
  }

  async function solveOrdering(entry) {
    const desired = entry.orderedKeys || [];
    if (!desired.length) return false;

    // Selection sort: for position i, find the item whose key == desired[i]
    // in the current DOM and move it to position i. Verify each move
    // landed before proceeding.
    for (let i = 0; i < desired.length; i++) {
      let items = getOrderingItems();
      const wantKey = desired[i];
      const currentIdx = items.findIndex((el) => getOrderingKey(el) === wantKey);
      if (currentIdx < 0) {
        log("ordering: missing item for key", wantKey);
        return false;
      }
      if (currentIdx === i) continue; // already in place
      const steps = i - currentIdx; // negative = move up
      await moveItem(items[currentIdx], steps);
      // Settle and verify
      await sleep(300);
      const verifyItems = getOrderingItems();
      if (getOrderingKey(verifyItems[i]) !== wantKey) {
        log("ordering: move " + i + " did not land, retrying");
        // Try once more
        const retryIdx = verifyItems.findIndex((el) => getOrderingKey(el) === wantKey);
        if (retryIdx >= 0 && retryIdx !== i) {
          await moveItem(verifyItems[retryIdx], i - retryIdx);
          await sleep(300);
        }
      }
    }
    // Final verification
    const finalItems = getOrderingItems();
    for (let i = 0; i < desired.length; i++) {
      if (getOrderingKey(finalItems[i]) !== desired[i]) {
        log("ordering: final order wrong at position " + i);
        return false;
      }
    }
    log("ordering: final order verified");
    return true;
  }

  // -------- matching solver --------------------------------------------
  // Recharge matching uses react-beautiful-dnd with two droppables:
  //   - "matching:<id>:choices"   (the bottom bank with draggable choice items)
  //   - "matching:<id>:response"  (the row drop zones, one per prompt)
  //
  // For each row (in DOM order), look up the correct choice key from the
  // entry's promptToChoice map (we get the prompt key by matching label
  // text to entry.matching.prompts), find the corresponding draggable in
  // the bank, lift it with Space, press ArrowUp until cross-list nav lands
  // it on the right row, drop with Space.
  //
  // The simpler reliable approach: rather than navigating cross-list (which
  // is tricky in rbd), we drop into the FIRST empty row, which auto-fills
  // the rows in DOM order. So we walk rows top-to-bottom and for each one
  // pick the corresponding correct choice from the bank.

  function getMatchRows() {
    return [...document.querySelectorAll(".match-row")];
  }

  function getMatchRowPromptText(row) {
    const el = row.querySelector(".match-prompt-label .content");
    return normalizeText(el ? el.textContent : "");
  }

  function getBankChoices() {
    return [...document.querySelectorAll('.choices-container .choice-item-wrapper[id^="choices:"]')];
  }

  function getBankChoiceKey(el) {
    if (!el) return null;
    const m = (el.id || "").match(/^choices:(.+)$/);
    return m ? m[1] : null;
  }

  async function solveMatching(entry) {
    const m = entry.matching;
    if (!m || !m.promptToChoice) return false;

    const promptTextToChoiceKey = {};
    for (const p of m.prompts || []) {
      const ck = m.promptToChoice[p.key];
      if (ck) promptTextToChoiceKey[p.text] = ck;
    }

    const rows = getMatchRows();
    if (!rows.length) return false;

    let success = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const promptText = getMatchRowPromptText(row);
      const wantKey = promptTextToChoiceKey[promptText];
      if (!wantKey) {
        log("matching: no answer for prompt", promptText);
        continue;
      }
      const bank = getBankChoices();
      const choice = bank.find((el) => getBankChoiceKey(el) === wantKey);
      if (!choice) {
        log("matching: choice missing", wantKey);
        continue;
      }
      const target = row.querySelector(".dropHolder") || row.querySelector(".dropWrapper") || row;
      const ok = await mouseDrag(choice, target);
      if (ok) success++;
      await sleep(350);
    }
    log("matching: placed " + success + "/" + rows.length);
    return success === rows.length;
  }

  // Synthesize a mouse-based drag from `from` to `to`. Designed for
  // react-beautiful-dnd which listens for mousedown -> mousemove (with
  // movement past the activation threshold) -> mouseup.
  async function mouseDrag(from, to) {
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const sx = fromRect.left + fromRect.width / 2;
    const sy = fromRect.top + fromRect.height / 2;
    const tx = toRect.left + toRect.width / 2;
    const ty = toRect.top + toRect.height / 2;

    function fire(type, x, y, target) {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });
      (target || document.elementFromPoint(x, y) || from).dispatchEvent(ev);
    }

    // mousedown on the source
    fire("mousedown", sx, sy, from);
    await sleep(60);

    // Small initial wiggle to satisfy rbd's drag-start threshold (~5px)
    fire("mousemove", sx + 8, sy + 8);
    await sleep(40);

    // Step the cursor toward the target in ~12 increments
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const x = sx + (tx - sx) * (i / steps);
      const y = sy + (ty - sy) * (i / steps);
      fire("mousemove", x, y);
      await sleep(20);
    }

    // Hover on target for a beat so rbd commits the drop target
    fire("mousemove", tx, ty);
    await sleep(80);

    // mouseup on the target
    fire("mouseup", tx, ty);
    await sleep(120);
    return true;
  }

  // Poll for `findFn()` to return an enabled element, then click it.
  // Returns a promise that resolves whether or not the click succeeded.
  function waitAndClick(findFn, name, intervalMs, maxTries) {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        tries++;
        const el = findFn();
        if (el) {
          el.click();
          log(name + " clicked");
          resolve(true);
          return;
        }
        if (tries >= maxTries) {
          log(name + " not found after " + tries + " tries");
          resolve(false);
          return;
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  async function bumpStat() {
    if (contextDead) return;
    try {
      const { solvedCount = 0 } = await chrome.storage.local.get(["solvedCount"]);
      chrome.storage.local.set({ solvedCount: solvedCount + 1 });
    } catch {
      contextDead = true;
    }
  }

  // -------- DOM observer ----------------------------------------------
  const obs = new MutationObserver(() => {
    // Coalesce — Angular fires lots of mutations per render
    if (obs.__pending) return;
    obs.__pending = true;
    setTimeout(() => {
      obs.__pending = false;
      tryAutoSolve("dom mutation");
    }, 120);
  });

  function startObserving() {
    if (!document.body) {
      setTimeout(startObserving, 50);
      return;
    }
    obs.observe(document.body, { childList: true, subtree: true });
    log("observer attached");
    tryAutoSolve("startup");
  }
  startObserving();

  // Safety net: every 3 seconds, if a question is on screen and we're
  // enabled, tick the solver. This catches the edge case where Recharge
  // re-renders the same stem (so MutationObserver mistakes it for "no
  // change") or where the cache update arrives during the autosubmit
  // chain and gets dropped after the queue flag clears.
  setInterval(() => {
    if (!contextDead && !solveInFlight) tryAutoSolve("heartbeat");
  }, 3000);

  // -------- popup commands --------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "solveNow") {
      solvedThisRender = false;
      tryAutoSolve("manual");
      sendResponse({ ok: true });
    } else if (msg.type === "dumpCache") {
      sendResponse({ ok: true, entries: [...cache.values()] });
    }
    return true;
  });
})();
