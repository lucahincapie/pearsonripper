// ============================================================
// Hotkeys
// ============================================================
chrome.commands.onCommand.addListener((command) => {
  runSolve(command === "solve-and-next");
});

// ============================================================
// Messages from popup + injected page script
// ============================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "trigger") {
    runSolve(!!msg.autoAdvance);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "askLLM") {
    askOpenAI(msg.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg.type === "setAuto") {
    setAutoMode(!!msg.on, msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "noQuestion") {
    // Top frame couldn't find a question after retries — likely assignment complete
    handleNoQuestion();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "getMainWorldContext") {
    getMainWorldContext(_sender.tab && _sender.tab.id)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "validateLicense") {
    validateLicense(msg.license)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});

// =============================================================
// Licensing
// =============================================================
// Set this to your Cloudflare Worker (or other backend) URL.
const LICENSE_SERVER = "https://pearson-bot-license.YOUR-SUBDOMAIN.workers.dev";

// Stable per-install device ID so we can rate-limit shared keys.
async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get(["deviceId"]);
  if (deviceId) return deviceId;
  const fresh =
    "d_" +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2);
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

async function validateLicense(license) {
  if (!license) throw new Error("No license key provided");
  const deviceId = await getDeviceId();
  let res;
  try {
    res = await fetch(`${LICENSE_SERVER}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license, deviceId }),
    });
  } catch (e) {
    throw new Error("Cannot reach license server");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.valid) {
    throw new Error(data.error || `Invalid license (HTTP ${res.status})`);
  }
  // data: { valid, plan, monthlyCap, validUntil (ms epoch) }
  await chrome.storage.local.set({
    license,
    licensePlan: data.plan || "Active",
    monthlyCap: data.monthlyCap || 1000,
    licenseValidUntil: data.validUntil || Date.now() + 86400000, // default 1 day
    licenseLastChecked: Date.now(),
  });
  return { plan: data.plan, monthlyCap: data.monthlyCap };
}

async function ensureLicenseValid() {
  const { license, licenseValidUntil, licenseLastChecked } =
    await chrome.storage.local.get([
      "license",
      "licenseValidUntil",
      "licenseLastChecked",
    ]);
  if (!license) throw new Error("No license. Activate one in the popup.");
  const now = Date.now();
  // If we've validated within the last 24h and it's still valid, accept.
  if (
    licenseValidUntil &&
    licenseValidUntil > now &&
    licenseLastChecked &&
    now - licenseLastChecked < 24 * 60 * 60 * 1000
  ) {
    return true;
  }
  // Otherwise re-check with the server (this also catches revocations).
  await validateLicense(license);
  return true;
}

// Reach into the page's MAIN world (where ppp lives) to grab subject
// metadata + any hint text Pearson preloaded into the problem state.
async function getMainWorldContext(tabId) {
  if (!tabId) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      try {
        if (typeof ppp === "undefined" || !ppp.config || !ppp.problems || !ppp.problems[0]) {
          return null;
        }
        const stripHtml = (s) =>
          String(s || "")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&[a-z]+;/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        const cfg = ppp.config;
        const meta = {
          bookCode: cfg.bookCode,
          bookTitle: cfg.bookTitle,
          bookAuthorList: cfg.bookAuthorList,
          chapterTitle: cfg.chapterTitle,
          sectionTitle: cfg.sectionTitle,
          discipline: cfg.discipline,
        };

        // Pull any hint text Pearson preloaded into each section's config.
        // Different question types stash hints under different keys, so we
        // grab anything that looks hint-like.
        const sections = (ppp.problems[0].sections || []).map((s) => {
          const c = (s && s.config) || {};
          const hints = [];
          const collect = (val, depth = 0) => {
            if (depth > 4) return;
            if (val == null) return;
            if (typeof val === "string") {
              const t = stripHtml(val);
              if (t.length >= 20) hints.push(t);
              return;
            }
            if (typeof val !== "object") return;
            for (const k of Object.keys(val)) {
              if (/hint|tip|explanation|followup|feedback/i.test(k)) {
                collect(val[k], depth + 1);
              }
            }
          };
          collect(c);

          // Followup is sometimes the explanation/answer rationale and is
          // worth pulling explicitly.
          if (c.followup) {
            const t = stripHtml(c.followup);
            if (t.length >= 20 && !hints.includes(t)) hints.push(t);
          }

          return {
            partId: c.id,
            text: stripHtml(c.text),
            hints,
          };
        });

        return { meta, sections };
      } catch (e) {
        return { error: String(e) };
      }
    },
  });
  return results && results[0] && results[0].result;
}

async function setAutoMode(on, tabId) {
  await chrome.storage.local.set({
    autoMode: on,
    autoTabId: on ? tabId : null,
    autoFailCount: 0,
    autoSolved: 0,
  });
  if (on && tabId) {
    // Kick it off immediately on the current question
    setTimeout(() => runSolve(true, tabId, true), 600);
  }
}

async function handleNoQuestion() {
  const { autoMode, autoFailCount = 0 } = await chrome.storage.local.get([
    "autoMode",
    "autoFailCount",
  ]);
  if (!autoMode) return;
  const next = autoFailCount + 1;
  if (next >= 2) {
    console.log("[pearson-bot] auto mode: no question 2x in a row, stopping");
    await chrome.storage.local.set({ autoMode: false, autoTabId: null, autoFailCount: 0 });
  } else {
    await chrome.storage.local.set({ autoFailCount: next });
  }
}

// ============================================================
// Auto mode: re-fire solver whenever the Pearson tab finishes loading
// ============================================================
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const { autoMode, autoTabId, autoSolved = 0 } = await chrome.storage.local.get([
    "autoMode",
    "autoTabId",
    "autoSolved",
  ]);
  if (!autoMode) return;
  if (autoTabId && autoTabId !== tabId) return;

  // Hard safety cap so a runaway loop can't drain your API credits
  if (autoSolved >= 200) {
    console.log("[pearson-bot] auto mode: hit 200-question safety cap, stopping");
    await chrome.storage.local.set({ autoMode: false, autoTabId: null });
    return;
  }

  // Wait for Pearson's YUI player to render the question into the DOM
  setTimeout(() => runSolve(true, tabId, true), 1000);
});

// ============================================================
// Inject solver into the active (or specified) tab
// ============================================================
async function runSolve(autoAdvance, tabIdOverride, isAutoMode) {
  let tabId = tabIdOverride;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    tabId = tab.id;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: solveInPage,
      args: [autoAdvance, !!isAutoMode],
    });
  } catch (e) {
    console.error("[pearson-bot] inject failed", e);
  }
}

// ============================================================
// OpenAI call
// ============================================================
async function checkAndIncrementMonthlyUsage() {
  const month = currentMonthKey();
  const { monthlyUsage = {}, monthlyCap = 1000 } = await chrome.storage.local.get([
    "monthlyUsage",
    "monthlyCap",
  ]);
  const used = monthlyUsage[month] || 0;
  if (used >= monthlyCap) {
    throw new Error(
      `Monthly cap reached (${used}/${monthlyCap}). Resets on the 1st.`
    );
  }
  monthlyUsage[month] = used + 1;
  // Garbage-collect old months so storage doesn't grow forever
  Object.keys(monthlyUsage).forEach((k) => {
    if (k !== month && k < month) delete monthlyUsage[k];
  });
  await chrome.storage.local.set({ monthlyUsage });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function askOpenAI(payload) {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("No API key set. Open the extension popup and save one.");

  // Verify the license is still valid (re-checks with server every 24h)
  await ensureLicenseValid();

  // Enforce monthly cap before spending money
  await checkAndIncrementMonthlyUsage();

  const { question, instructions, images, kind, subject } = payload;
  const subjectLine = subject
    ? `\nSubject context: ${subject}\n`
    : "";

  let sys, userText;

  if (kind === "sorting") {
    const { items, bins } = payload;
    sys =
      "You are answering a Pearson MyLab sort/categorize question. " +
      "Each draggable item must be placed into exactly one bin. " +
      "Return ONLY a JSON object of the form " +
      '{"assignments":[{"item":<item index>,"bin":<bin index>}, ...],"reason":"<one short sentence>"}. ' +
      "Include exactly one entry per item. Indexes are 0-based and refer to the arrays I give you.";
    userText =
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Items (drag these):\n` +
      items.map((c, i) => `  ${i}. ${c}`).join("\n") +
      `\nBins (drop targets):\n` +
      bins.map((c, i) => `  ${i}. ${c}`).join("\n");
  } else if (kind === "vocab") {
    const { words, blanks } = payload;
    sys =
      "You are answering a Pearson MyLab fill-in-the-blank question. " +
      "Each blank in a sentence must be filled with exactly one of the provided words/phrases. " +
      "Each word is used exactly once (one-to-one mapping). " +
      "Return ONLY a JSON object of the form " +
      '{"assignments":[{"blank":<blank index>,"word":<word index>}, ...],"reason":"<short reasoning>"}. ' +
      "Include exactly one entry per blank. Indexes are 0-based.";
    userText =
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Words/phrases (drag these):\n` +
      words.map((w, i) => `  ${i}. ${w}`).join("\n") +
      `\nBlanks (sentences with __ marking the blank):\n` +
      blanks.map((b, i) => `  ${i}. ${b}`).join("\n");
  } else if (kind === "ranking") {
    const { items, slots } = payload;
    sys =
      "You are answering a Pearson MyLab ranking/ordering question. " +
      "Place each item into the correct ordered slot (e.g. chronological order). " +
      "Return ONLY a JSON object of the form " +
      '{"order":[<item index for slot 0>, <item index for slot 1>, ...],"reason":"<one short sentence>"}. ' +
      `The "order" array must have exactly ${slots} entries (one per slot, in order from first to last). ` +
      "Each entry is the 0-based index of the item that belongs in that position. " +
      "Each item index should appear exactly once.";
    userText =
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Number of slots (ordered positions): ${slots}\n` +
      `Items (place each into its correct slot):\n` +
      items.map((c, i) => `  ${i}. ${c}`).join("\n");
  } else {
    const { choices, multi } = payload;
    sys =
      "You are an expert tutor answering Pearson MyLab questions across all subjects " +
      "(biology, chemistry, physics, math, statistics, accounting, economics, business, " +
      "psychology, sociology, history, anatomy, nursing, etc.). " +
      "The question may include images — examine them carefully and extract every " +
      "relevant visual detail (diagrams, graphs, tables, charts, structures, equations, " +
      "labels, numerical values, axes, units) before answering.\n\n" +
      "Think step by step:\n" +
      "1. If there's an image, describe what's visible in detail.\n" +
      "2. Identify the key terms, given values, and what the question is actually asking.\n" +
      "3. For math/physics/chemistry, perform any needed calculations carefully and double-check units.\n" +
      "4. For 'select all that apply', evaluate EACH choice independently against the question. Include every choice that is true. Do NOT stop at the first correct one — usually 2-4 are correct.\n" +
      "5. For single-answer questions, pick the single best choice.\n\n" +
      "Return ONLY a JSON object of the form " +
      '{"reasoning":"<brief reasoning including image/calculation details if relevant>","answers":[<0-based index>, ...]}. ' +
      "For single-answer questions, return exactly one index. " +
      "For 'select all that apply', return every index that is correct. " +
      "Indexes refer to the order of the provided choices array.";
    userText =
      subjectLine +
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Type: ${multi ? "SELECT ALL THAT APPLY (multiple correct answers)" : "single answer"}\n` +
      `Choices:\n` +
      choices.map((c, i) => `  ${i}. ${c}`).join("\n");
  }

  const userContent = [{ type: "text", text: userText }];
  if (Array.isArray(images)) {
    for (const url of images) {
      userContent.push({ type: "image_url", image_url: { url } });
    }
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ============================================================
// Injected into the page
// ============================================================
function solveInPage(autoAdvance, isAutoMode) {
  const log = (...a) => console.log("[pearson-bot]", ...a);
  const isTop = window === window.top;

  let attempts = 0;
  const maxAttempts = isTop ? 25 : 1; // ~7.5s in top frame; subframes bail immediately
  const solvedPartIds = new Set();

  // Auto-mode kill switch. Only enforced when this run was started by
  // auto mode (Start Auto Mode button). Manual one-shot triggers like
  // Solve / Solve+Next bypass it entirely.
  async function autoStillOn() {
    if (!isAutoMode) return true;
    try {
      const { autoMode } = await chrome.storage.local.get(["autoMode"]);
      return !!autoMode;
    } catch (_) {
      return true;
    }
  }

  function isPartCompleted(partEl) {
    if (!partEl) return false;
    // Pearson shows a visible check/X (.part-complete loses .invisible)
    // and disables the Submit button on a completed part.
    const indicator = partEl.querySelector(".part-complete");
    if (indicator && !indicator.classList.contains("invisible")) return true;
    const submit = partEl.querySelector("span.answer-button.submit");
    if (submit && !submit.classList.contains("enabled")) return true;
    return false;
  }

  function pickOpenPart() {
    const openParts = Array.from(
      document.querySelectorAll(".sections .section.part.foldy.open")
    );
    // Mark any already-completed parts as solved so we never pick them
    openParts.forEach((el) => {
      if (el.id && isPartCompleted(el)) solvedPartIds.add(el.id);
    });
    // Prefer an open, NOT-completed part we haven't solved yet
    const fresh = openParts.find(
      (el) => el.id && !solvedPartIds.has(el.id) && !isPartCompleted(el)
    );
    if (fresh) return fresh;
    // Single-part fallback: only if it's not completed
    const any = openParts.find((el) => !isPartCompleted(el));
    return any || null;
  }

  function findStuff() {
    const root =
      pickOpenPart() ||
      document.querySelector(".section.foldy.open") ||
      document.querySelector("#problempane") ||
      document;

    const qEl =
      root.querySelector('.text.edible[prop="text"]') ||
      document.querySelector('.text.edible[prop="text"]');
    if (!qEl) return null;

    // Sorting / drag-drop widget?
    const sorting = root.querySelector(".sorting") || root.querySelector(".sort-items");
    if (sorting) {
      const sortingRoot = sorting.closest(".sorting") || sorting.parentElement;
      const items = Array.from(sortingRoot.querySelectorAll(".sort-item"));
      const bins = Array.from(sortingRoot.querySelectorAll(".sort-bin"));
      if (items.length && bins.length) {
        return { kind: "sorting", root, qEl, sortingRoot, items, bins };
      }
    }

    // Ranking widget (ordered placement, e.g. chronological sequence)?
    const ranking = root.querySelector(".ranking") || root.querySelector(".rank-items");
    if (ranking) {
      const rankRoot = ranking.closest(".ranking") || ranking.parentElement;
      const items = Array.from(rankRoot.querySelectorAll(".rank-item"));
      const zones = Array.from(rankRoot.querySelectorAll(".rank-zone"));
      if (items.length && zones.length) {
        return { kind: "ranking", root, qEl, rankRoot, items, zones };
      }
    }

    // Vocab / fill-in-the-blank widget (drag word into a sentence blank)
    const vocab = root.querySelector(".vocab") || root.querySelector(".word-list");
    if (vocab) {
      const vocabRoot = vocab.closest(".vocab") || vocab.parentElement;
      const words = Array.from(vocabRoot.querySelectorAll(".word"));
      const blanks = Array.from(vocabRoot.querySelectorAll(".blank"));
      if (words.length && blanks.length) {
        return { kind: "vocab", root, qEl, vocabRoot, words, blanks };
      }
    }

    // Standard input-based widget (radio / checkbox)
    const work =
      root.querySelector('.work[type^="solution"]') ||
      document.querySelector('.work[type^="solution"]');

    if (work) {
      const inputs = Array.from(
        work.querySelectorAll(
          'input.mult-option-input, fieldset.options input[type="checkbox"], fieldset.options input[type="radio"]'
        )
      );
      if (inputs.length) {
        return { kind: "choice", root, qEl, work, inputs };
      }
    }

    // Open part with no solvable widget (e.g. an intro/text-only section
    // with just a Submit/Continue button). Mark it for skipping so the
    // auto-loop doesn't get stuck.
    const partEl = root.closest && root.closest(".section.part");
    if (partEl && partEl.querySelector("span.answer-button.submit")) {
      return { kind: "skip", root: partEl };
    }

    return null;
  }

  async function tryFind() {
    if (!(await autoStillOn())) {
      log("auto mode off — stopping");
      return;
    }
    const found = findStuff();
    if (found) {
      if (found.kind === "skip") {
        log("text-only / no-input part — skipping:", found.root.id);
        if (found.root.id) solvedPartIds.add(found.root.id);
        if (autoAdvance) submitAndAdvance(found.root);
        return;
      }
      const fn =
        found.kind === "sorting"
          ? doSortingSolve
          : found.kind === "ranking"
          ? doRankingSolve
          : found.kind === "vocab"
          ? doVocabSolve
          : doSolve;
      fn(found).catch((e) => console.error("[pearson-bot] solve error", e));
      return;
    }
    attempts++;
    if (attempts < maxAttempts) {
      setTimeout(tryFind, 300);
    } else {
      if (isTop) {
        log("no question element found after retries");
        try {
          chrome.runtime.sendMessage({ type: "noQuestion" });
        } catch (_) {}
      }
    }
  }

  function collectImageDescriptions(scope) {
    const descs = new Set();
    const push = (s) => {
      if (!s) return;
      const t = String(s).replace(/\s+/g, " ").trim();
      if (t.length >= 20) descs.add(t);
    };

    // 1. img alt / aria-label / aria-describedby / longdesc
    scope.querySelectorAll("img").forEach((img) => {
      push(img.alt);
      push(img.getAttribute("aria-label"));
      const describedby = img.getAttribute("aria-describedby");
      if (describedby) {
        describedby.split(/\s+/).forEach((id) => {
          const el = document.getElementById(id);
          if (el) push(el.textContent);
        });
      }
    });

    // 2. Common Pearson / accessibility hidden-description containers
    const selectors = [
      ".sr-only",
      ".visually-hidden",
      ".visuallyhidden",
      ".a11y-only",
      ".long-desc",
      ".longdesc",
      ".image-description",
      ".image-desc",
      ".alt-text",
      "[role='img'] [aria-label]",
      "figcaption",
    ];
    scope.querySelectorAll(selectors.join(",")).forEach((el) => push(el.textContent));

    return Array.from(descs);
  }

  // Grab any "stimulus" / passage / scenario text that lives in the same
  // problem as the current part but OUTSIDE the .section.part wrappers,
  // plus any already-completed parts (which often contain context the
  // remaining parts refer back to, like "the patient with X").
  function collectProblemContext(currentPartEl) {
    const problem = currentPartEl?.closest(".problem") || document.querySelector(".problem");
    if (!problem) return "";

    const chunks = [];

    // 1. Text that lives directly in the problem but not inside any part
    //    (Pearson sometimes puts a shared scenario at the top.)
    problem.querySelectorAll('.text.edible[prop="text"], .stim, .stimulus, .intro, .scenario').forEach((el) => {
      if (el.closest(".section.part")) return; // skip per-part text
      const t = (el.innerText || el.textContent).replace(/\s+/g, " ").trim();
      if (t) chunks.push(t);
    });

    // 2. Text from sibling parts that are NOT the current one — useful when
    //    a later part says "the bacterium in Part A" etc. We include each
    //    other part's question text only.
    problem.querySelectorAll(".section.part").forEach((partEl) => {
      if (partEl === currentPartEl) return;
      const ord = partEl.getAttribute("ordinal") || "";
      const txtEl = partEl.querySelector('.text.edible[prop="text"]');
      if (!txtEl) return;
      const t = (txtEl.innerText || txtEl.textContent).replace(/\s+/g, " ").trim();
      if (t) chunks.push(`(Part ${ord}) ${t}`);
    });

    return chunks.join("\n\n");
  }

  async function collectImages(scope) {
    const imgs = Array.from(scope.querySelectorAll("img"));
    const out = [];
    for (const img of imgs) {
      const rawSrc = img.currentSrc || img.src;
      if (!rawSrc) continue;
      // Skip tiny icons (chevrons, checkmarks, etc.)
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h && w < 32 && h < 32) continue;
      try {
        const absUrl = new URL(rawSrc, document.baseURI).href;
        const r = await fetch(absUrl, { credentials: "include" });
        if (!r.ok) {
          log("image fetch failed", r.status, absUrl);
          continue;
        }
        const blob = await r.blob();
        if (blob.size > 4 * 1024 * 1024) {
          log("image too large, skipping", absUrl, blob.size);
          continue;
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
        out.push(dataUrl);
        if (out.length >= 6) break; // hard cap
      } catch (e) {
        log("image error", e);
      }
    }
    return out;
  }

  // ----- Drag-and-drop via Pearson's keyboard accessibility path ----------
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function fireKey(target, type, key) {
    const ev = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
      code: key === " " ? "Space" : key,
      keyCode: key === " " ? 32 : key === "Enter" ? 13 : 9,
      which: key === " " ? 32 : key === "Enter" ? 13 : 9,
      view: window,
    });
    target.dispatchEvent(ev);
  }
  async function pressSpace(el) {
    el.focus();
    await sleep(80);
    fireKey(el, "keydown", " ");
    fireKey(el, "keypress", " ");
    fireKey(el, "keyup", " ");
    await sleep(150);
  }

  async function dragItemToBin(itemEl, binEl) {
    const handle =
      itemEl.querySelector(".item-container-box") ||
      itemEl.querySelector(".wordcontent") ||
      itemEl.querySelector("[role='button'][tabindex='0']") ||
      itemEl;
    const target =
      binEl.querySelector("[role='region'][tabindex='0']") ||
      binEl.querySelector("[tabindex='0']") ||
      binEl;

    // 1. Focus + Space on item to "grab" it
    handle.scrollIntoView({ block: "center" });
    await sleep(100);
    await pressSpace(handle);

    // Verify grab
    const grabbed =
      handle.getAttribute("aria-pressed") === "true" ||
      itemEl.getAttribute("data-grabbed") === "true";
    if (!grabbed) {
      log("warn: item didn't register as grabbed:", handle.textContent);
    }

    // 2. Focus the bin and press Space to drop
    target.scrollIntoView({ block: "center" });
    await sleep(100);
    await pressSpace(target);

    // Brief settle
    await sleep(150);
  }

  async function doSortingSolve({ root, qEl, sortingRoot, items, bins }) {
    const instrEl =
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');

    const itemTexts = items.map((li) => {
      const box = li.querySelector(".item-container-box") || li;
      return (box.innerText || box.textContent).replace(/\s+/g, " ").trim();
    });
    const binLabels = bins.map((li) => {
      const labeled = li.querySelector("[aria-label]");
      const header = li.querySelector(".sort-bin-header-txt");
      return (
        labeled?.getAttribute("aria-label") ||
        header?.textContent ||
        li.id ||
        ""
      ).replace(/\s+/g, " ").trim();
    });

    const question = (qEl.innerText || qEl.textContent).replace(/\s+/g, " ").trim();
    const instructions = instrEl
      ? (instrEl.innerText || instrEl.textContent).replace(/\s+/g, " ").trim()
      : "";

    const imageScope = root.querySelector(".bd") || root;
    const imageDescriptions = collectImageDescriptions(imageScope);
    const images = await collectImages(imageScope);

    const context = collectProblemContext(root.closest(".section.part") || root);
    const fullQuestion =
      (context ? `Shared context for this question:\n${context}\n\n` : "") +
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "");

    log("SORTING Q:", question);
    log("items:", itemTexts);
    log("bins:", binLabels);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "sorting",
          question: fullQuestion,
          instructions,
          items: itemTexts,
          bins: binLabels,
          images,
        },
      },
      async (resp) => {
        if (!resp || !resp.ok) {
          console.error("[pearson-bot] LLM error:", resp && resp.error);
          return;
        }
        const data = resp.data || {};
        const assignments = Array.isArray(data.assignments) ? data.assignments : [];
        log("assignments:", assignments, "reason:", data.reason);

        try {
          chrome.storage.local.get(["autoSolved"]).then(({ autoSolved = 0 }) => {
            chrome.storage.local.set({
              autoFailCount: 0,
              autoSolved: autoSolved + 1,
            });
          });
        } catch (_) {}

        // Scroll the sorting widget into view so all elements have valid coords
        sortingRoot.scrollIntoView({ block: "center" });
        await sleep(300);

        for (const a of assignments) {
          const itemIdx = Number(a.item);
          const binIdx = Number(a.bin);
          if (
            !Number.isInteger(itemIdx) || itemIdx < 0 || itemIdx >= items.length ||
            !Number.isInteger(binIdx) || binIdx < 0 || binIdx >= bins.length
          ) continue;
          const itemEl = items[itemIdx];
          const binEl = bins[binIdx];
          if (!itemEl || !binEl) continue;
          log(`drag "${itemTexts[itemIdx]}" -> "${binLabels[binIdx]}"`);
          try {
            await dragItemToBin(itemEl, binEl);
          } catch (e) {
            console.error("[pearson-bot] drag failed", e);
          }
        }

        if (autoAdvance) submitAndAdvance(root);
      }
    );
  }

  // Ranking widget — like sorting but slots are ordered positions, not categories
  async function doRankingSolve({ root, qEl, rankRoot, items, zones }) {
    const instrEl =
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');

    const itemTexts = items.map((li) => {
      // Prefer data-label since Pearson populates it directly
      return (
        li.getAttribute("data-label") ||
        (li.querySelector(".item-container-box")?.innerText ||
          li.textContent ||
          "")
      ).replace(/\s+/g, " ").trim();
    });

    const question = (qEl.innerText || qEl.textContent).replace(/\s+/g, " ").trim();
    const instructions = instrEl
      ? (instrEl.innerText || instrEl.textContent).replace(/\s+/g, " ").trim()
      : "";

    const imageScope = root.querySelector(".bd") || root;
    const imageDescriptions = collectImageDescriptions(imageScope);
    const images = await collectImages(imageScope);

    const context = collectProblemContext(root.closest(".section.part") || root);
    const fullQuestion =
      (context ? `Shared context for this question:\n${context}\n\n` : "") +
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "");

    log("RANKING Q:", question);
    log("items:", itemTexts);
    log("slots:", zones.length);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "ranking",
          question: fullQuestion,
          instructions,
          items: itemTexts,
          slots: zones.length,
          images,
        },
      },
      async (resp) => {
        if (!resp || !resp.ok) {
          console.error("[pearson-bot] LLM error:", resp && resp.error);
          return;
        }
        const data = resp.data || {};
        const order = Array.isArray(data.order) ? data.order : [];
        log("order:", order, "reason:", data.reason);

        try {
          chrome.storage.local.get(["autoSolved"]).then(({ autoSolved = 0 }) => {
            chrome.storage.local.set({
              autoFailCount: 0,
              autoSolved: autoSolved + 1,
            });
          });
        } catch (_) {}

        rankRoot.scrollIntoView({ block: "center" });
        await sleep(300);

        // For each slot, drag the assigned item into it
        for (let slotIdx = 0; slotIdx < zones.length; slotIdx++) {
          const itemIdx = Number(order[slotIdx]);
          if (!Number.isInteger(itemIdx) || itemIdx < 0 || itemIdx >= items.length) continue;
          const itemEl = items[itemIdx];
          const zoneEl = zones[slotIdx];
          if (!itemEl || !zoneEl) continue;
          log(`rank "${itemTexts[itemIdx]}" -> slot ${slotIdx + 1}`);
          try {
            await dragItemToBin(itemEl, zoneEl);
          } catch (e) {
            console.error("[pearson-bot] rank drag failed", e);
          }
        }

        if (autoAdvance) submitAndAdvance(root);
      }
    );
  }

  // Vocab / fill-in-the-blank widget — drag a word into a sentence's blank
  async function doVocabSolve({ root, qEl, vocabRoot, words, blanks }) {
    const instrEl =
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');

    const wordTexts = words.map((li) => {
      const span = li.querySelector(".wordcontent") || li;
      return (span.innerText || span.textContent || "").replace(/\s+/g, " ").trim();
    });

    // Build a sentence string for each blank using its data-sentence attribute,
    // which Pearson conveniently provides with a "__blank" placeholder.
    const blankTexts = blanks.map((b) => {
      const raw = b.getAttribute("data-sentence") || b.parentElement?.textContent || "";
      return raw
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/__blank/gi, "____")
        .replace(/\s+/g, " ")
        .trim();
    });

    const question = (qEl.innerText || qEl.textContent).replace(/\s+/g, " ").trim();
    const instructions = instrEl
      ? (instrEl.innerText || instrEl.textContent).replace(/\s+/g, " ").trim()
      : "";

    const imageScope = root.querySelector(".bd") || root;
    const imageDescriptions = collectImageDescriptions(imageScope);
    const images = await collectImages(imageScope);

    const context = collectProblemContext(root.closest(".section.part") || root);
    const fullQuestion =
      (context ? `Shared context for this question:\n${context}\n\n` : "") +
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "");

    log("VOCAB Q:", question);
    log("words:", wordTexts);
    log("blanks:", blankTexts);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "vocab",
          question: fullQuestion,
          instructions,
          words: wordTexts,
          blanks: blankTexts,
          images,
        },
      },
      async (resp) => {
        if (!resp || !resp.ok) {
          console.error("[pearson-bot] LLM error:", resp && resp.error);
          return;
        }
        const data = resp.data || {};
        const assignments = Array.isArray(data.assignments) ? data.assignments : [];
        log("assignments:", assignments, "reason:", data.reason || data.reasoning);

        try {
          chrome.storage.local.get(["autoSolved"]).then(({ autoSolved = 0 }) => {
            chrome.storage.local.set({
              autoFailCount: 0,
              autoSolved: autoSolved + 1,
            });
          });
        } catch (_) {}

        vocabRoot.scrollIntoView({ block: "center" });
        await sleep(300);

        for (const a of assignments) {
          const blankIdx = Number(a.blank);
          const wordIdx = Number(a.word);
          if (
            !Number.isInteger(blankIdx) || blankIdx < 0 || blankIdx >= blanks.length ||
            !Number.isInteger(wordIdx) || wordIdx < 0 || wordIdx >= words.length
          ) continue;
          const wordEl = words[wordIdx];
          const blankEl = blanks[blankIdx];
          if (!wordEl || !blankEl) continue;
          log(`vocab "${wordTexts[wordIdx]}" -> blank ${blankIdx + 1}`);
          try {
            await dragItemToBin(wordEl, blankEl);
          } catch (e) {
            console.error("[pearson-bot] vocab drag failed", e);
          }
        }

        if (autoAdvance) submitAndAdvance(root);
      }
    );
  }

  // Shared submit + advance logic (also used by choice handler)
  function submitAndAdvance(root) {
    const solvedPartEl = root.closest(".section.part") || root;
    const solvedPartId = solvedPartEl.id || "";
    if (solvedPartId) solvedPartIds.add(solvedPartId);

    setTimeout(async () => {
      if (!(await autoStillOn())) {
        log("auto mode off — not submitting");
        return;
      }
      const submit =
        solvedPartEl.querySelector("span.answer-button.submit.enabled") ||
        solvedPartEl.querySelector("span.answer-button.submit") ||
        document.querySelector("span.answer-button.submit.enabled") ||
        document.querySelector("span.answer-button.submit") ||
        document.querySelector(".answer-button.submit");
      if (submit) {
        log("clicking submit for part", solvedPartId || "(unknown)");
        submit.click();
      }

      let polls = 0;
      const maxPolls = 12; // ~2.4s
      const poll = async () => {
        if (!(await autoStillOn())) {
          log("auto mode off — stopping poll");
          return;
        }
        polls++;
        const openParts = Array.from(
          document.querySelectorAll(".sections .section.part.foldy.open")
        ).filter((el) =>
          el.querySelector(".work[type^='solution'], .sorting, .sort-items, .ranking, .rank-items, .vocab, .word-list")
        );

        // Has a part we haven't solved yet (and that isn't already completed) appeared?
        openParts.forEach((el) => {
          if (el.id && isPartCompleted(el)) solvedPartIds.add(el.id);
        });
        const fresh = openParts.find(
          (el) => el.id && !solvedPartIds.has(el.id) && !isPartCompleted(el)
        );
        if (fresh) {
          log("new part opened:", fresh.id, "- solving it");
          attempts = 0;
          tryFind();
          return;
        }

        // No fresh part — either the whole question is done, or Pearson
        // is still processing. After enough polls, click Next.
        if (polls >= maxPolls) {
          const next = document.getElementById("handleContinueLink");
          if (next) {
            log("clicking next");
            next.click();
          } else {
            log("no Next button found — assignment likely complete, stopping auto mode");
            try {
              chrome.storage.local.set({ autoMode: false, autoTabId: null });
            } catch (_) {}
          }
          return;
        }
        setTimeout(poll, 200);
      };
      setTimeout(poll, 400);
    }, 150);
  }

  // Fetch subject metadata + Pearson-preloaded hints from the page's main world.
  async function fetchMainWorldContext() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "getMainWorldContext" }, (r) =>
          resolve(r && r.ok ? r.data : null)
        );
      } catch (_) {
        resolve(null);
      }
    });
  }

  function buildSubjectString(meta) {
    if (!meta) return "";
    const parts = [];
    if (meta.bookTitle) parts.push(meta.bookTitle);
    if (meta.chapterTitle) parts.push(`Chapter: ${meta.chapterTitle}`);
    if (meta.discipline) parts.push(meta.discipline);
    return parts.join(" — ");
  }

  function findHintsForPart(mainCtx, partEl) {
    if (!mainCtx || !mainCtx.sections || !partEl) return [];
    const partId = partEl.getAttribute("sectionid");
    if (!partId) return [];
    const section = mainCtx.sections.find((s) => String(s.partId) === String(partId));
    return (section && section.hints) || [];
  }

  async function doSolve({ root, qEl, work, inputs }) {
    const workType = work.getAttribute("type") || "";
    const isMulti = /MultipleSelect/i.test(workType);

    const instrEl =
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');

    const choices = inputs.map((inp) => {
      const lbl =
        document.querySelector(`label[for="${inp.id}"]`) ||
        inp.closest("td, li, tr")?.querySelector("label");
      return (lbl?.innerText || lbl?.textContent || "").replace(/\s+/g, " ").trim();
    });

    const question = (qEl.innerText || qEl.textContent).replace(/\s+/g, " ").trim();
    const instructions = instrEl
      ? (instrEl.innerText || instrEl.textContent).replace(/\s+/g, " ").trim()
      : "";

    // Grab images + their text descriptions from the whole problem area
    const imageScope = root.querySelector(".bd") || root;
    const imageDescriptions = collectImageDescriptions(imageScope);
    const images = await collectImages(imageScope);

    const context = collectProblemContext(root.closest(".section.part") || root);

    // Pull subject + hints from page main-world
    const mainCtx = await fetchMainWorldContext();
    const subject = buildSubjectString(mainCtx && mainCtx.meta);
    const hints = findHintsForPart(mainCtx, root.closest(".section.part"));

    const fullQuestion =
      (context ? `Shared context for this question:\n${context}\n\n` : "") +
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (hints.length
        ? "\n\nPearson-preloaded hints / explanations (these may directly contain or strongly suggest the answer):\n- " +
          hints.join("\n- ")
        : "");

    log("Q:", question);
    log("instr:", instructions);
    log("choices:", choices);
    log("multi:", isMulti);
    log("image descriptions:", imageDescriptions.length);
    log("images:", images.length);
    log("subject:", subject || "(none)");
    log("hints:", hints.length);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          question: fullQuestion,
          instructions,
          choices,
          multi: isMulti,
          images,
          subject,
        },
      },
      (resp) => {
        if (!resp || !resp.ok) {
          console.error("[pearson-bot] LLM error:", resp && resp.error);
          return;
        }
        const data = resp.data || {};
        let answers = Array.isArray(data.answers) ? data.answers : [data.answers];
        answers = answers
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < inputs.length);

        log("picked:", answers, "reason:", data.reasoning || data.reason);

        // Reset fail counter and bump solved counter (best-effort)
        try {
          chrome.storage.local.get(["autoSolved"]).then(({ autoSolved = 0 }) => {
            chrome.storage.local.set({
              autoFailCount: 0,
              autoSolved: autoSolved + 1,
            });
          });
        } catch (_) {}

        answers.forEach((i) => {
          const inp = inputs[i];
          if (!inp) return;
          if (!inp.checked) {
            const lbl = document.querySelector(`label[for="${inp.id}"]`);
            if (lbl) lbl.click();
            if (!inp.checked) inp.click();
          }
        });

        if (autoAdvance) submitAndAdvance(root);
      }
    );
  }

  tryFind();
}
