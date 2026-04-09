// ============================================================
// Coursepilot — Pearson handlers (loaded via importScripts in background.js)
// ============================================================
// All exported functions live on the service worker's global scope:
//   runSolve, setAutoMode, askOpenAI, getMainWorldContext,
//   handleNoQuestion, fetchAnswerKey, getAnswerKeyForChapterTitle,
//   fetchEtextSection, fetchVideoContext
//
// The unified background.js routes incoming messages to these.
// License/onCommand/onMessage handlers were here originally — they now
// live in background.js so they can be shared with the McGraw side.
// ============================================================

// Licensing functions (validateLicense, ensureLicenseValid, getDeviceId,
// MASTER_LICENSE, LICENSE_SERVER) live in background.js so they're shared
// with the McGraw side. ensureLicenseValid() is still called from askOpenAI
// below — it's defined in background.js and visible on the same global scope
// because pearson-handlers.js is loaded via importScripts().

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
        // MxData (global) has the inItemLinkURL that points at the eText
        // section relevant to this problem. We use this to fetch the actual
        // textbook content as authoritative context for the LLM.
        const mx = (typeof MxData !== "undefined" && MxData) || {};
        const meta = {
          bookCode: cfg.bookCode,
          bookTitle: cfg.bookTitle,
          bookAuthorList: cfg.bookAuthorList,
          chapterTitle: cfg.chapterTitle,
          sectionTitle: cfg.sectionTitle,
          discipline: cfg.discipline,
          inItemLinkURL: mx.inItemLinkURL || cfg.inItemLinkURL || "",
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

// =============================================================
// eText fetching — get the actual textbook chapter section
// =============================================================
// Pearson stores each chapter section as a static XHTML file at:
//   https://plus.pearson.com/epub/bronte/{productId}/v22/OPS/xhtml/{pageId}.xhtml
// We get from a question to that URL by:
//   1. Reading MxData.inItemLinkURL (a /myct/inItemEtextLinkLaunch?... path)
//   2. Following its redirects to a plus.pearson.com page URL containing the
//      productId + pageId
//   3. Fetching the .xhtml file directly
// The xhtml is the real, authoritative chapter text — feeding it to GPT as
// context turns "guessing from training" into "reading the book".
const _etextCache = new Map();

async function fetchEtextSection(inItemLinkURL, originHost) {
  if (!inItemLinkURL) return null;
  const cacheKey = inItemLinkURL;
  if (_etextCache.has(cacheKey)) return _etextCache.get(cacheKey);

  try {
    // Build the absolute launcher URL on the same Pearson session host the
    // page is loaded from (e.g. session.microbiology-mastering.pearson.com).
    const launcherUrl = inItemLinkURL.startsWith("http")
      ? inItemLinkURL
      : `https://${originHost}${inItemLinkURL}`;

    // Step 1: hit the launcher. It returns HTML with a self-submitting form
    // that POSTs to openclass. We need to replicate the form submission.
    const launchRes = await fetch(launcherUrl, { credentials: "include" });
    if (!launchRes.ok) {
      console.log("[pearson-bot] etext launcher failed", launchRes.status);
      _etextCache.set(cacheKey, null);
      return null;
    }
    const launchHtml = await launchRes.text();

    // Parse the form: action URL + hidden inputs
    const formMatch = launchHtml.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch) {
      console.log("[pearson-bot] etext launcher: no form found");
      console.log("[pearson-bot] body:", launchHtml.slice(0, 500));
      _etextCache.set(cacheKey, null);
      return null;
    }
    const action = formMatch[1].replace(/&amp;/g, "&");
    const formBody = formMatch[2];
    const formData = new URLSearchParams();
    const inputRegex = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*\/?>/gi;
    let im;
    while ((im = inputRegex.exec(formBody)) !== null) {
      const name = im[1];
      const value = im[2].replace(/&amp;/g, "&");
      formData.append(name, value);
    }

    // Pull the productId out of the form fields directly
    const productId = formData.get("custom_bookid") || formData.get("bookid") || formData.get("productId");
    if (!productId) {
      console.log("[pearson-bot] etext launcher: no productId in form");
      _etextCache.set(cacheKey, null);
      return null;
    }

    // Step 2: POST the form to openclass
    let postRes;
    try {
      postRes = await fetch(action, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        body: formData.toString(),
      });
    } catch (e) {
      console.log("[pearson-bot] etext openclass POST failed", e);
      _etextCache.set(cacheKey, null);
      return null;
    }
    const finalUrl = postRes.url || "";
    let postBody = "";
    try { postBody = await postRes.text(); } catch (_) {}

    // Now look for pageId. Try the post-response URL and body.
    let pageId = null;
    const idPatterns = [
      /\/pages\/([0-9a-f-]{36})/i,
      /pageId["'\s:=]+([0-9a-f-]{36})/i,
      /pageUUID["'\s:=]+([0-9a-f-]{36})/i,
      /"id"\s*:\s*"([0-9a-f-]{36})"/i,
    ];
    for (const pat of idPatterns) {
      const mm = (finalUrl + " " + postBody).match(pat);
      if (mm) { pageId = mm[1]; break; }
    }

    if (!pageId) {
      console.log("[pearson-bot] etext: no pageId after POST");
      console.log("[pearson-bot] post finalUrl:", finalUrl);
      console.log("[pearson-bot] post body (first 2000 chars):", postBody.slice(0, 2000));
      _etextCache.set(cacheKey, null);
      return null;
    }

    // Step 2: fetch the actual xhtml chapter content
    const xhtmlUrl = `https://plus.pearson.com/epub/bronte/${productId}/v22/OPS/xhtml/${pageId}.xhtml`;
    const xRes = await fetch(xhtmlUrl, { credentials: "include" });
    if (!xRes.ok) {
      console.log("[pearson-bot] etext xhtml fetch failed", xRes.status, xhtmlUrl);
      _etextCache.set(cacheKey, null);
      return null;
    }
    const xhtml = await xRes.text();

    // Strip everything that isn't body text. Keep the headings + paragraphs.
    let text = xhtml
      .replace(/<\?xml[^?]*\?>/g, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<math[\s\S]*?<\/math>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Cap to keep prompt costs sane. 8k chars ≈ 2000 tokens — enough for
    // the relevant paragraphs near the top of any chapter section.
    if (text.length > 8000) text = text.slice(0, 8000);
    console.log("[pearson-bot] etext extracted", text.length, "chars from", xhtmlUrl);

    const result = { productId, pageId, text };
    _etextCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.log("[pearson-bot] fetchEtextSection error", e);
    _etextCache.set(cacheKey, null);
    return null;
  }
}

// =============================================================
// Answer key appendix — the textbook's own answer key
// =============================================================
// Many Pearson textbooks ship an "Appendix A: Answers to End of Chapter
// Questions" as a regular xhtml page in the eText package. We discovered
// the appendix UUID for Norman-McKay Microbiology 2e. Different books
// will have different UUIDs — we cache per (productId, UUID).
//
// Known mapping: bookCode → appendix UUID.
const ANSWER_KEY_UUIDS = {
  // Norman-McKay Microbiology: Basic and Clinical Principles, 2e
  "norman_mbcp2": {
    productId: "BRNT-2R33MKQLKIO",
    uuid: "ffdd44e0-6e46-11ec-a051-c928cb0dce3d",
  },
};

// Cache: bookCode → { fullText, byChapter: { 1: "...", 2: "...", ... } }
const _answerKeyCache = new Map();

async function fetchAnswerKey(bookCode) {
  if (!bookCode) return null;
  if (_answerKeyCache.has(bookCode)) return _answerKeyCache.get(bookCode);
  const entry = ANSWER_KEY_UUIDS[bookCode];
  if (!entry) {
    console.log("[pearson-bot] no answer key UUID registered for", bookCode);
    _answerKeyCache.set(bookCode, null);
    return null;
  }
  try {
    const url = `https://plus.pearson.com/epub/bronte/${entry.productId}/v22/OPS/xhtml/${entry.uuid}.xhtml`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      console.log("[pearson-bot] answer key fetch failed", res.status, url);
      _answerKeyCache.set(bookCode, null);
      return null;
    }
    const xhtml = await res.text();

    // Extract body text, same pipeline as eText
    const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const raw = bodyMatch ? bodyMatch[1] : xhtml;
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<math[\s\S]*?<\/math>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Split by "Chapter N" markers so we can pull just the relevant chapter
    // per question (much smaller prompts + better focus).
    const markers = [...text.matchAll(/Chapter (\d+)/g)].map((m) => ({
      num: parseInt(m[1], 10),
      pos: m.index,
    }));
    const byChapter = {};
    for (let i = 0; i < markers.length; i++) {
      const end = markers[i + 1] ? markers[i + 1].pos : text.length;
      byChapter[markers[i].num] = text.slice(markers[i].pos, end).trim();
    }
    console.log("[pearson-bot] answer key loaded:", text.length, "chars,", Object.keys(byChapter).length, "chapters");

    const result = { fullText: text, byChapter };
    _answerKeyCache.set(bookCode, result);
    return result;
  } catch (e) {
    console.log("[pearson-bot] fetchAnswerKey error", e);
    _answerKeyCache.set(bookCode, null);
    return null;
  }
}

// Pull the most-likely-relevant chapter slice from the answer key for a
// given chapter title (e.g. "14. Biomedical Applications: ..."). Returns
// an empty string if nothing matches.
function getAnswerKeyForChapterTitle(answerKey, chapterTitle) {
  if (!answerKey || !chapterTitle) return "";
  const m = chapterTitle.match(/(\d+)/);
  if (!m) return "";
  const chapterNum = parseInt(m[1], 10);
  return (answerKey.byChapter && answerKey.byChapter[chapterNum]) || "";
}

// Fetch Pearson clinical-video popup pages and extract any visible text
// (transcripts, captions, on-page descriptions). These pages are on a
// different origin (media.pearsoncmg.com) but `<all_urls>` host_permission
// lets the background script fetch them. Cached in memory for the session.
const _videoCtxCache = new Map();
async function fetchVideoContext(urls) {
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    if (_videoCtxCache.has(url)) {
      out.push(_videoCtxCache.get(url));
      continue;
    }
    try {
      // Try without credentials first (popup pages don't need auth and
      // credentialed cross-origin fetches sometimes get rejected). Fall
      // back to credentialed if that fails.
      let r;
      try {
        r = await fetch(url);
      } catch (_) {
        r = await fetch(url, { credentials: "include" });
      }
      if (!r.ok) {
        console.log("[pearson-bot] video fetch failed", url, r.status);
        _videoCtxCache.set(url, { url, error: `HTTP ${r.status}` });
        continue;
      }
      const html = await r.text();

      // Strip scripts/styles, then extract text
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ");

      // Try to find transcript-like blocks first. Pearson clinical popups
      // use class names like "side-text", "optional-text", "transcript".
      const transcriptMatch = cleaned.match(
        /<(?:div|section|p)[^>]*(?:transcript|caption|cc-text|description|side-text|optional-text|case-text|story-text)[^>]*>([\s\S]*?)<\/(?:div|section|p)>/i
      );
      let extractedText;
      if (transcriptMatch) {
        extractedText = transcriptMatch[1];
      } else {
        // Fallback: pull <body> contents
        const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        extractedText = bodyMatch ? bodyMatch[1] : cleaned;
      }

      // Plain-text the result
      extractedText = extractedText
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      console.log("[pearson-bot] video text extracted", url, extractedText.length, "chars");

      // Also look for VTT caption file references and fetch them
      const vttMatch = html.match(/["'](https?:\/\/[^"']+\.vtt[^"']*)["']/i);
      if (vttMatch) {
        try {
          const vr = await fetch(vttMatch[1]);
          if (vr.ok) {
            const vtt = await vr.text();
            const cues = vtt
              .split("\n")
              .filter((l) => l && !/^\d+$/.test(l) && !/-->/.test(l) && !/^WEBVTT/.test(l))
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (cues) extractedText = (extractedText + " " + cues).slice(0, 8000);
          }
        } catch (_) {}
      }

      const entry = { url, text: extractedText.slice(0, 8000) };
      _videoCtxCache.set(url, entry);
      out.push(entry);
    } catch (e) {
      _videoCtxCache.set(url, { url, error: String(e) });
    }
  }
  return out;
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
  const { autoMode, autoFailCount = 0, autoTabId } = await chrome.storage.local.get([
    "autoMode",
    "autoFailCount",
    "autoTabId",
  ]);
  if (!autoMode) return;
  const next = autoFailCount + 1;
  // Be much more patient with weird/unhandleable questions. The previous
  // 2-strike threshold killed auto mode whenever a single question type
  // was unsupported. Now: try clicking Next a couple times to skip past
  // unhandleable questions, only stop after 5 consecutive failures.
  if (next >= 5) {
    console.log("[pearson-bot] auto mode: no question 5x in a row, stopping");
    await chrome.storage.local.set({ autoMode: false, autoTabId: null, autoFailCount: 0 });
    return;
  }
  await chrome.storage.local.set({ autoFailCount: next });
  // After the 2nd failure, try clicking Next to skip the stuck question.
  if (next >= 2 && autoTabId) {
    console.log("[pearson-bot] auto mode: trying to click Next to skip stuck question");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: autoTabId },
        func: () => {
          const next = document.getElementById("handleContinueLink");
          if (next) next.click();
        },
      });
    } catch (_) {}
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

  const { question, instructions, images, kind, subject, stablePrefix } = payload;
  const subjectLine = subject
    ? `\nSubject context: ${subject}\n`
    : "";
  // Stable prefix (subject + shared context + eText + transcripts) is
  // prepended to EVERY user message so OpenAI's automatic prompt caching
  // kicks in — any repeat request in the same chapter hits the cache at
  // 25% of normal input cost for this prefix.
  const cachePrefix = stablePrefix ? `${stablePrefix}\n\n---\n\n` : "";

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
      cachePrefix +
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Items (drag these):\n` +
      items.map((c, i) => `  ${i}. ${c}`).join("\n") +
      `\nBins (drop targets):\n` +
      bins.map((c, i) => `  ${i}. ${c}`).join("\n");
  } else if (kind === "vocab") {
    const { words, blanks } = payload;
    // If there are fewer words than blanks, words are reusable (e.g.
    // True/False matching, where every blank gets one of two labels).
    // Otherwise it's a one-to-one mapping (each word used exactly once).
    const reusable = words.length < blanks.length;
    sys =
      "You are answering a Pearson MyLab fill-in-the-blank question. " +
      "Each blank in a sentence must be filled with one of the provided words/phrases. " +
      (reusable
        ? "Words can be REUSED — the same word may fill multiple blanks. Choose the correct word for each blank independently. "
        : "Each word is used exactly once (one-to-one mapping). ") +
      "Return ONLY a JSON object of the form " +
      '{"assignments":[{"blank":<blank index>,"word":<word index>}, ...],"reason":"<short reasoning>"}. ' +
      "Include exactly one entry per blank (every blank must be assigned). Indexes are 0-based.";
    userText =
      cachePrefix +
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Words/phrases (drag these${reusable ? "; each can be reused multiple times" : ""}):\n` +
      words.map((w, i) => `  ${i}. ${w}`).join("\n") +
      `\nBlanks (${blanks.length} total — assign one word to each):\n` +
      blanks.map((b, i) => `  ${i}. ${b}`).join("\n");
  } else if (kind === "labeling") {
    const { labels, targets } = payload;
    sys =
      "You are answering a Pearson MyLab labeling question. " +
      "Text labels must be dragged onto specific targets shown on a background image. " +
      "Each label is used exactly once (one-to-one mapping with targets). " +
      "The image is provided — examine it carefully. Each target's description tells you " +
      "what region of the image it points to. Match each label to the target it correctly names. " +
      "Return ONLY a JSON object of the form " +
      '{"assignments":[{"label":<label index>,"target":<target index>}, ...],"reason":"<short reasoning>"}. ' +
      "Include exactly one entry per label. Indexes are 0-based.";
    userText =
      cachePrefix +
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Labels (drag these):\n` +
      labels.map((c, i) => `  ${i}. ${c}`).join("\n") +
      `\nTargets (regions on the image):\n` +
      targets.map((c, i) => `  ${i}. ${c}`).join("\n");
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
      cachePrefix +
      `Question: ${question}\n` +
      `Instructions: ${instructions || "(none)"}\n` +
      `Number of slots (ordered positions): ${slots}\n` +
      `Items (place each into its correct slot):\n` +
      items.map((c, i) => `  ${i}. ${c}`).join("\n");
  } else {
    const { choices, multi } = payload;
    sys =
      "You are an expert tutor answering Pearson MyLab questions across all subjects. " +
      "If an OFFICIAL TEXTBOOK ANSWER KEY is provided in the context, match the current " +
      "question against it and use that answer whenever it applies — the answer key is the " +
      "author's ground truth. " +
      "The question may include images — examine them carefully.\n\n" +
      "CRITICAL RULE for 'SELECT ALL THAT APPLY' questions:\n" +
      "- Evaluate EACH choice independently as a standalone true/false statement.\n" +
      "- Include EVERY choice that is individually correct.\n" +
      "- The typical correct count is 2-4 out of 4-6 choices. Returning only 1 correct " +
      "answer on a multi-select is almost always wrong — if you only picked 1, re-check " +
      "each remaining choice and ask 'is this also true?' before finalizing.\n" +
      "- Distractors usually contain ONE wrong detail; trust choices that are fully consistent " +
      "with the textbook.\n\n" +
      "For single-answer questions, pick the single best choice.\n\n" +
      "Return ONLY a JSON object of the form " +
      '{"reasoning":"<one short sentence>","answers":[<0-based index>, ...]}. ' +
      "Keep reasoning brief — 1-2 sentences max. Indexes are 0-based and refer to the order of the provided choices array.";
    userText =
      cachePrefix +
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

  // Retry on 429 (rate limit) and 5xx (transient server errors) with
  // exponential backoff. OpenAI's 429 responses include a retry-after hint
  // we honor when present; otherwise we back off 3/6/12 seconds.
  const maxAttempts = 4;
  let res, data;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4.1",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 500,
      }),
    });

    if (res.ok) break;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const txt = await res.text();
      throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
    }

    // Parse retry-after header (seconds or HTTP date). Otherwise back off.
    let waitMs = attempt * 3000; // 3s, 6s, 9s
    const ra = res.headers.get("retry-after");
    if (ra) {
      const s = Number(ra);
      if (!isNaN(s)) waitMs = Math.max(1000, s * 1000);
    } else {
      // Check the error body for "try again in Xs"
      try {
        const txt = await res.text();
        const m = txt.match(/try again in ([\d.]+)s/i);
        if (m) waitMs = Math.max(1000, Math.ceil(parseFloat(m[1]) * 1000) + 500);
      } catch (_) {}
    }
    console.log(`[pearson-bot] OpenAI ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts - 1})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  data = await res.json();
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
    const picked = pickOpenPart();

    // If there ARE open parts but all of them are completed (already-graded
    // multi-part question), don't try to re-solve them — signal "advance".
    if (!picked) {
      const openParts = Array.from(
        document.querySelectorAll(".sections .section.part.foldy.open")
      );
      if (openParts.length && openParts.every(isPartCompleted)) {
        return { kind: "advance", root: openParts[0] };
      }
    }

    let root = picked;
    if (!root) {
      const fallback = document.querySelector(".section.foldy.open");
      if (fallback && !isPartCompleted(fallback)) {
        root = fallback;
      } else {
        root = document.querySelector("#problempane") || document;
      }
    }

    // Question text can live in `.text[prop="text"]` OR, for parts with no
    // explicit question text, in `.instructions[prop="instructions"]` alone.
    // Fall back to the instructions element if there's no text element.
    const qEl =
      root.querySelector('.text.edible[prop="text"]') ||
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.text.edible[prop="text"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');
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

    // Labeling widget — drag text labels onto targets on a background image
    // (solutionAppletLabel). Must come BEFORE the generic .work[type^=solution]
    // check since its work element also starts with "solution".
    const labeling = root.querySelector(".labeling");
    if (labeling) {
      const labels = Array.from(labeling.querySelectorAll("li.label-group"));
      const targets = Array.from(labeling.querySelectorAll("g.target-group"));
      if (labels.length && targets.length) {
        return { kind: "labeling", root, qEl, labelingRoot: labeling, labels, targets };
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
        if (autoAdvance) submitAndAdvance(found.root, "skip");
        return;
      }
      if (found.kind === "advance") {
        log("all open parts already completed — clicking Next");
        const next = document.getElementById("handleContinueLink");
        if (next) {
          next.click();
        } else {
          log("no Next button — assignment likely complete, stopping auto mode");
          try {
            chrome.storage.local.set({ autoMode: false, autoTabId: null });
          } catch (_) {}
        }
        return;
      }
      const fn =
        found.kind === "sorting"
          ? doSortingSolve
          : found.kind === "ranking"
          ? doRankingSolve
          : found.kind === "vocab"
          ? doVocabSolve
          : found.kind === "labeling"
          ? doLabelingSolve
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
    //    (Pearson sometimes puts a shared scenario / case study at the top.)
    //    `.introduction[prop="introduction"]` is the case-study stimulus on
    //    multi-part clinical questions — critical context, do NOT miss it.
    problem.querySelectorAll(
      '.text.edible[prop="text"], .introduction.edible[prop="introduction"], [prop="introduction"], .introBox, .stim, .stimulus, .intro, .scenario'
    ).forEach((el) => {
      if (el.closest(".section.part")) return; // skip per-part text
      const t = (el.innerText || el.textContent).replace(/\s+/g, " ").trim();
      if (t) chunks.push(t);
    });
    // De-dupe (introBox wraps introduction, so both selectors hit the same text)
    const seen = new Set();
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (seen.has(chunks[i])) chunks.splice(i, 1);
      else seen.add(chunks[i]);
    }

    // 2. Text from sibling parts that are NOT the current one. Includes:
    //    - the part's question text
    //    - the .followup explanation (Pearson reveals this AFTER a part is
    //      submitted and it usually contains the full mechanistic answer —
    //      which often spells out the answer to LATER parts in the same
    //      problem). Pure gold for accuracy.
    //    - the .feedback text from wrong attempts (hints at what's right)
    problem.querySelectorAll(".section.part").forEach((partEl) => {
      if (partEl === currentPartEl) return;
      const ord = partEl.getAttribute("ordinal") || "";
      const txtEl = partEl.querySelector('.text.edible[prop="text"]');
      if (txtEl) {
        const t = (txtEl.innerText || txtEl.textContent).replace(/\s+/g, " ").trim();
        if (t) chunks.push(`(Part ${ord}) ${t}`);
      }
      // Followups + feedback from already-graded parts
      partEl.querySelectorAll(".followup, .feedback").forEach((el) => {
        const t = (el.innerText || el.textContent).replace(/\s+/g, " ").trim();
        if (t) chunks.push(`(Part ${ord} explanation) ${t}`);
      });
    });

    // 3. Narrative transitions between parts. These are .section.transition
    //    blocks that hold short bridging exposition ("Dr. Smith continues to
    //    explain that..."). Critical context for the parts that follow them.
    problem.querySelectorAll(".section.transition").forEach((transEl) => {
      const txtEl = transEl.querySelector('.text.edible[prop="text"]');
      if (!txtEl) return;
      const t = (txtEl.innerText || txtEl.textContent).replace(/\s+/g, " ").trim();
      if (t) chunks.push(`(Transition) ${t}`);
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

  // Vocab applet uses click-driven interaction (the wordcontent span has
  // tabindex=-1 and aria-pressed already set, so the focus+Space pattern
  // doesn't trigger the YUI vocab handler). Click the word to grab, then
  // click the blank to drop. Falls back to focus+Space+Enter if click alone
  // doesn't take.
  function fireMouse(target, type) {
    const rect = target.getBoundingClientRect();
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    target.dispatchEvent(ev);
  }
  async function clickEl(el) {
    el.scrollIntoView({ block: "center" });
    await sleep(80);
    el.focus();
    fireMouse(el, "mousedown");
    fireMouse(el, "mouseup");
    fireMouse(el, "click");
    await sleep(150);
  }
  // Synthetic YUI3 DD-compatible drag: mousedown, several mousemove steps
  // (YUI requires motion to "start" the drag), then mouseup on the target.
  function fireMouseAt(target, type, x, y) {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: type === "mouseup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(ev);
  }
  async function syntheticDrag(sourceEl, targetEl) {
    targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    await sleep(120);
    const sRect0 = sourceEl.getBoundingClientRect();
    if (sRect0.top < 0 || sRect0.bottom > window.innerHeight) {
      sourceEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(120);
      targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(120);
    }

    const sRect = sourceEl.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const sx = sRect.left + sRect.width / 2;
    const sy = sRect.top + sRect.height / 2;
    const tx = tRect.left + tRect.width / 2;
    const ty = tRect.top + tRect.height / 2;

    // 1. Press down on source
    fireMouseAt(sourceEl, "mousedown", sx, sy);
    await sleep(60);

    // 2. Move a tiny amount first (YUI uses a movement threshold to start drag)
    fireMouseAt(sourceEl, "mousemove", sx + 5, sy + 5);
    await sleep(40);
    fireMouseAt(document, "mousemove", sx + 10, sy + 10);
    await sleep(40);

    // 3. Step toward the target so YUI tracks the drag through the page
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = sx + ((tx - sx) * i) / steps;
      const y = sy + ((ty - sy) * i) / steps;
      fireMouseAt(document, "mousemove", x, y);
      await sleep(20);
    }

    // 4. Final move + mouseup directly on the target
    fireMouseAt(targetEl, "mousemove", tx, ty);
    await sleep(40);
    fireMouseAt(targetEl, "mouseup", tx, ty);
    await sleep(150);
  }

  // HTML5 native drag-and-drop with a real DataTransfer. Some Pearson
  // widgets (notably the labeling applet) opt into HTML5 DnD via
  // draggable=true on inner spans.
  async function html5Drag(sourceEl, targetEl) {
    targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    await sleep(120);
    const sRect0 = sourceEl.getBoundingClientRect();
    if (sRect0.top < 0 || sRect0.bottom > window.innerHeight) {
      sourceEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(120);
      targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(120);
    }

    const dt = new DataTransfer();
    // Pre-seed common keys so handlers that read in dragstart get something
    const sid = sourceEl.id || sourceEl.getAttribute("data-label-id") || "";
    try { dt.setData("text/plain", sid); } catch (_) {}
    try { dt.setData("text", sid); } catch (_) {}

    const sRect = sourceEl.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const sx = sRect.left + sRect.width / 2;
    const sy = sRect.top + sRect.height / 2;
    const tx = tRect.left + tRect.width / 2;
    const ty = tRect.top + tRect.height / 2;

    const dispatch = (el, type, x, y) => {
      try {
        const ev = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dt,
          clientX: x,
          clientY: y,
          view: window,
        });
        el.dispatchEvent(ev);
      } catch (_) {}
    };

    dispatch(sourceEl, "dragstart", sx, sy);
    await sleep(60);
    // Step the "drag" toward the target so handlers tracking dragover get hits
    dispatch(sourceEl, "drag", sx, sy);
    await sleep(40);
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = sx + ((tx - sx) * i) / steps;
      const y = sy + ((ty - sy) * i) / steps;
      const elAtPoint = document.elementFromPoint(x, y) || targetEl;
      dispatch(elAtPoint, "dragenter", x, y);
      dispatch(elAtPoint, "dragover", x, y);
      await sleep(30);
    }
    dispatch(targetEl, "dragenter", tx, ty);
    dispatch(targetEl, "dragover", tx, ty);
    await sleep(60);
    dispatch(targetEl, "drop", tx, ty);
    await sleep(60);
    dispatch(sourceEl, "dragend", tx, ty);
    await sleep(150);
  }

  // Pointer-event drag at document level. Modern YUI3 / Pearson code often
  // uses pointer events instead of mouse events.
  async function pointerDrag(sourceEl, targetEl) {
    // Use "nearest" to minimize scrolling so both source and target are
    // more likely to fit in the viewport at the same time. Don't scroll
    // source if doing so would push target off-screen.
    targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    await sleep(100);
    const sRect0 = sourceEl.getBoundingClientRect();
    const sourceVisible = sRect0.top >= 0 && sRect0.bottom <= window.innerHeight;
    if (!sourceVisible) {
      sourceEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(100);
      // Re-check that target is still visible; if not, we'll just dispatch
      // events using whatever coordinates and let the handler figure it out.
      targetEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      await sleep(100);
    }
    const sRect = sourceEl.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const sx = sRect.left + sRect.width / 2;
    const sy = sRect.top + sRect.height / 2;
    const tx = tRect.left + tRect.width / 2;
    const ty = tRect.top + tRect.height / 2;

    const fire = (target, type, x, y, opts = {}) => {
      try {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          ...opts,
        });
        target.dispatchEvent(ev);
      } catch (_) {}
      // Also fire matching mouse event
      const mouseType = type.replace("pointer", "mouse");
      try {
        const mev = new MouseEvent(mouseType, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
        });
        target.dispatchEvent(mev);
      } catch (_) {}
    };

    fire(sourceEl, "pointerdown", sx, sy);
    await sleep(50);
    fire(sourceEl, "pointermove", sx + 8, sy + 8);
    await sleep(40);

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = sx + ((tx - sx) * i) / steps;
      const y = sy + ((ty - sy) * i) / steps;
      const elAtPoint = document.elementFromPoint(x, y) || document.body;
      fire(elAtPoint, "pointermove", x, y);
      await sleep(25);
    }

    fire(targetEl, "pointermove", tx, ty);
    await sleep(40);
    fire(targetEl, "pointerup", tx, ty);
    await sleep(150);
  }


  // Combined signature of source + target that captures any state-change
  // that indicates a successful drop, across all widget types:
  //   - Sorting/ranking/vocab: source.parentElement changes (it gets moved
  //     into the target's drop container).
  //   - Labeling: source.style.left/top change (label is repositioned over
  //     the target while remaining in the labels-layer).
  //   - Labeling: target's tabindex flips 0 → -1 and aria-label gets the
  //     label text appended.
  //   - Sorting/vocab: target may gain/lose .empty/.filled classes.
  // Excludes things that change on focus alone (which would be false
  // positives because focus doesn't mean a drop landed).
  function dragPairSignature(sourceEl, targetEl) {
    return [
      // source side
      sourceEl.parentElement ? sourceEl.parentElement.id || sourceEl.parentElement.className : "",
      sourceEl.style.left || "",
      sourceEl.style.top || "",
      sourceEl.getAttribute("data-x") || "",
      sourceEl.getAttribute("data-y") || "",
      // target side
      targetEl.getAttribute("tabindex") || "",
      targetEl.getAttribute("focusable") || "",
      targetEl.getAttribute("aria-label") || "",
      targetEl.querySelectorAll("*").length,
      targetEl.classList.contains("empty") ? "e" : "f",
      targetEl.classList.contains("filled") ? "F" : "",
    ].join("|");
  }

  // Release any stuck "grabbed" / mid-drag state before starting a new drag.
  // YUI vocab/DD applets sometimes leave the previous drag source in
  // aria-pressed=true / draggable=false after a successful drop, which
  // causes subsequent drags to fail. Dispatching Escape and clicking
  // outside the widget clears that state.
  async function releaseAnyDragState() {
    try {
      // Escape key is the standard YUI DD cancel
      const ev = new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true,
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
      });
      document.dispatchEvent(ev);
      const ev2 = new KeyboardEvent("keyup", {
        bubbles: true, cancelable: true,
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
      });
      document.dispatchEvent(ev2);
    } catch (_) {}
    // Forcibly reset any stuck word elements: aria-pressed=false, draggable=true
    document.querySelectorAll('.word [aria-pressed="true"]').forEach((el) => {
      el.setAttribute("aria-pressed", "false");
      el.setAttribute("draggable", "true");
    });
    // Also unset border-color highlighting on stuck word LIs
    document.querySelectorAll(".word.interactive").forEach((li) => {
      if (li.style && li.style.borderColor) li.style.borderColor = "";
    });
    await sleep(60);
  }

  async function dragItemToBin(itemEl, binEl) {
    // Make sure no previous drag is stuck in "grabbed" state
    await releaseAnyDragState();

    // The "interactive handle" — what keyboard/click should target.
    const handle =
      itemEl.querySelector(".item-container-box") ||
      itemEl.querySelector(".wordcontent") ||
      itemEl.querySelector("[role='button'][tabindex='0']") ||
      itemEl;
    // The "draggable element" — what HTML5 DnD / mouse / pointer events
    // should fire on. Labeling widget uses an inner span with draggable=true;
    // for sorting/ranking/vocab the LI itself is the draggable.
    const draggable =
      itemEl.querySelector('[draggable="true"]') ||
      itemEl;
    // The drop target — most widgets use the bin/zone itself.
    const target =
      binEl.querySelector("[role='region'][tabindex='0']") ||
      binEl.querySelector("[tabindex='0']") ||
      binEl;

    const before = dragPairSignature(itemEl, binEl);
    const changed = () => dragPairSignature(itemEl, binEl) !== before;

    // Strategy 1: keyboard (focus + Space). Works for sorting/ranking.
    try {
      handle.scrollIntoView({ block: "center" });
      await sleep(100);
      await pressSpace(handle);
      target.scrollIntoView({ block: "center" });
      await sleep(100);
      await pressSpace(target);
      await sleep(150);
      if (changed()) return;
    } catch (e) {
      log("keyboard drag error:", e);
    }

    // Strategy 2: HTML5 native DnD (works for labeling — inner span has
    // draggable=true). Try this BEFORE pointer/mouse since it's the most
    // direct match for elements that opt into HTML5 DnD.
    try {
      await html5Drag(draggable, binEl);
      if (changed()) return;
    } catch (e) {
      log("html5 drag error:", e);
    }

    // Strategy 3: pointer events (works for vocab)
    try {
      await pointerDrag(draggable, binEl);
      if (changed()) return;
    } catch (e) {
      log("pointer drag error:", e);
    }

    // Strategy 4: mouse synthetic drag
    try {
      await syntheticDrag(draggable, binEl);
      if (changed()) return;
    } catch (e) {
      log("mouse drag error:", e);
    }

    // Strategy 5: plain click on handle then click on target
    try {
      await clickEl(handle);
      await clickEl(binEl);
      if (changed()) return;
    } catch (e) {
      log("click drag error:", e);
    }

    log("warn: all drag strategies failed for", handle.textContent);
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

    // Pull subject + Pearson-preloaded hints from page main-world
    const mainCtx = await fetchMainWorldContext();
    const hints = findHintsForPart(mainCtx, root.closest(".section.part"));
    const etext = await fetchEtextSectionInPage(mainCtx && mainCtx.meta && mainCtx.meta.inItemLinkURL);
    const bookCode = (mainCtx && mainCtx.meta && mainCtx.meta.bookCode) || "";
    const chapterTitle = (mainCtx && mainCtx.meta && mainCtx.meta.chapterTitle) || "";
    const answerKeySlice = await fetchAnswerKeyInPage(bookCode, chapterTitle);

    // Cacheable prefix — shared across all questions in this chapter
    const useEtext = !answerKeySlice && etext && etext.text;
    const stablePrefix =
      (answerKeySlice
        ? "OFFICIAL TEXTBOOK ANSWER KEY for this chapter (from Appendix A — authoritative author-written answers; match against these):\n" +
          answerKeySlice + "\n\n"
        : "") +
      (useEtext
        ? "Relevant textbook chapter section (authoritative — the answer is somewhere in here):\n" +
          etext.text + "\n\n"
        : "") +
      (context ? `Shared context for this question:\n${context}\n\n` : "");

    const fullQuestion =
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (hints.length
        ? "\n\nPearson-preloaded hints / explanations (these may directly contain or strongly suggest the answer):\n- " +
          hints.join("\n- ")
        : "");

    log("SORTING Q:", question);
    log("answer key:", answerKeySlice ? `${answerKeySlice.length} chars` : "(none)");
    log("hints:", hints.length);
    log("etext:", etext && etext.text ? `${etext.text.length} chars` : "(none)");
    log("items:", itemTexts);
    log("bins:", binLabels);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "sorting",
          question: fullQuestion,
          stablePrefix,
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

        if (autoAdvance) submitAndAdvance(root, "sorting");
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

    const mainCtx = await fetchMainWorldContext();
    const hints = findHintsForPart(mainCtx, root.closest(".section.part"));
    const etext = await fetchEtextSectionInPage(mainCtx && mainCtx.meta && mainCtx.meta.inItemLinkURL);
    const bookCode = (mainCtx && mainCtx.meta && mainCtx.meta.bookCode) || "";
    const chapterTitle = (mainCtx && mainCtx.meta && mainCtx.meta.chapterTitle) || "";
    const answerKeySlice = await fetchAnswerKeyInPage(bookCode, chapterTitle);

    const useEtext = !answerKeySlice && etext && etext.text;
    const stablePrefix =
      (answerKeySlice
        ? "OFFICIAL TEXTBOOK ANSWER KEY for this chapter (from Appendix A — authoritative author-written answers; match against these):\n" +
          answerKeySlice + "\n\n"
        : "") +
      (useEtext
        ? "Relevant textbook chapter section (authoritative — the answer is somewhere in here):\n" +
          etext.text + "\n\n"
        : "") +
      (context ? `Shared context for this question:\n${context}\n\n` : "");

    const fullQuestion =
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (hints.length
        ? "\n\nPearson-preloaded hints / explanations (these may directly contain or strongly suggest the answer):\n- " +
          hints.join("\n- ")
        : "");

    log("RANKING Q:", question);
    log("answer key:", answerKeySlice ? `${answerKeySlice.length} chars` : "(none)");
    log("hints:", hints.length);
    log("etext:", etext && etext.text ? `${etext.text.length} chars` : "(none)");
    log("items:", itemTexts);
    log("slots:", zones.length);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "ranking",
          question: fullQuestion,
          stablePrefix,
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

        if (autoAdvance) submitAndAdvance(root, "ranking");
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

    const mainCtx = await fetchMainWorldContext();
    const hints = findHintsForPart(mainCtx, root.closest(".section.part"));
    const etext = await fetchEtextSectionInPage(mainCtx && mainCtx.meta && mainCtx.meta.inItemLinkURL);
    const bookCode = (mainCtx && mainCtx.meta && mainCtx.meta.bookCode) || "";
    const chapterTitle = (mainCtx && mainCtx.meta && mainCtx.meta.chapterTitle) || "";
    const answerKeySlice = await fetchAnswerKeyInPage(bookCode, chapterTitle);

    const useEtext = !answerKeySlice && etext && etext.text;
    const stablePrefix =
      (answerKeySlice
        ? "OFFICIAL TEXTBOOK ANSWER KEY for this chapter (from Appendix A — authoritative author-written answers; match against these):\n" +
          answerKeySlice + "\n\n"
        : "") +
      (useEtext
        ? "Relevant textbook chapter section (authoritative — the answer is somewhere in here):\n" +
          etext.text + "\n\n"
        : "") +
      (context ? `Shared context for this question:\n${context}\n\n` : "");

    const fullQuestion =
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (hints.length
        ? "\n\nPearson-preloaded hints / explanations (these may directly contain or strongly suggest the answer):\n- " +
          hints.join("\n- ")
        : "");

    log("VOCAB Q:", question);
    log("answer key:", answerKeySlice ? `${answerKeySlice.length} chars` : "(none)");
    log("hints:", hints.length);
    log("etext:", etext && etext.text ? `${etext.text.length} chars` : "(none)");
    log("words:", wordTexts);
    log("blanks:", blankTexts);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "vocab",
          question: fullQuestion,
          stablePrefix,
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

        if (autoAdvance) submitAndAdvance(root, "vocab");
      }
    );
  }

  // Labeling widget — drag text labels onto targets on a background image
  async function doLabelingSolve({ root, qEl, labelingRoot, labels, targets }) {
    const instrEl =
      root.querySelector('.instructions.edible[prop="instructions"]') ||
      document.querySelector('.instructions.edible[prop="instructions"]');

    const labelTexts = labels.map((li) => {
      const span = li.querySelector(".label-sr-span span") || li.querySelector("span") || li;
      return (span.innerText || span.textContent || "").replace(/\s+/g, " ").trim();
    });

    // Each target's description tells us what region of the image it points to.
    // Try multiple sources: aria-label, aria-labelledby targets, child sr-only
    // text, title, data-label. Concatenate everything we find.
    const targetTexts = targets.map((g, i) => {
      const parts = [];
      const ariaLabel = g.getAttribute("aria-label");
      if (ariaLabel) parts.push(ariaLabel);
      const labelledby = g.getAttribute("aria-labelledby");
      if (labelledby) {
        labelledby.split(/\s+/).forEach((id) => {
          const el = document.getElementById(id);
          if (el) parts.push(el.textContent);
        });
      }
      const describedby = g.getAttribute("aria-describedby");
      if (describedby) {
        describedby.split(/\s+/).forEach((id) => {
          const el = document.getElementById(id);
          if (el) parts.push(el.textContent);
        });
      }
      g.querySelectorAll(".sr-only, .sr-only-description, title, desc").forEach((el) => {
        parts.push(el.textContent);
      });
      const title = g.getAttribute("title");
      if (title) parts.push(title);
      const dataLabel = g.getAttribute("data-label") || g.getAttribute("data-target-id");
      if (dataLabel) parts.push(dataLabel);
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      return text || `target ${i + 1}`;
    });

    const question = (qEl.innerText || qEl.textContent).replace(/\s+/g, " ").trim();
    const instructions = instrEl
      ? (instrEl.innerText || instrEl.textContent).replace(/\s+/g, " ").trim()
      : "";

    const imageScope = root.querySelector(".bd") || root;
    const imageDescriptions = collectImageDescriptions(imageScope);
    // Also pull the trans-layer aria-label, which is the full SR description
    // of the labeling background image (Pearson hides this from collectImageDescriptions
    // because it's on a div, not an img).
    const transLayer = labelingRoot.querySelector(".trans-layer[aria-label]");
    if (transLayer) {
      const t = transLayer.getAttribute("aria-label").replace(/\s+/g, " ").trim();
      if (t) imageDescriptions.unshift(t);
    }
    const images = await collectImages(imageScope);

    const context = collectProblemContext(root.closest(".section.part") || root);

    const mainCtx = await fetchMainWorldContext();
    const hints = findHintsForPart(mainCtx, root.closest(".section.part"));
    const etext = await fetchEtextSectionInPage(mainCtx && mainCtx.meta && mainCtx.meta.inItemLinkURL);
    const bookCode = (mainCtx && mainCtx.meta && mainCtx.meta.bookCode) || "";
    const chapterTitle = (mainCtx && mainCtx.meta && mainCtx.meta.chapterTitle) || "";
    const answerKeySlice = await fetchAnswerKeyInPage(bookCode, chapterTitle);

    const useEtext = !answerKeySlice && etext && etext.text;
    const stablePrefix =
      (answerKeySlice
        ? "OFFICIAL TEXTBOOK ANSWER KEY for this chapter (from Appendix A — authoritative author-written answers; match against these):\n" +
          answerKeySlice + "\n\n"
        : "") +
      (useEtext
        ? "Relevant textbook chapter section (authoritative — the answer is somewhere in here):\n" +
          etext.text + "\n\n"
        : "") +
      (context ? `Shared context for this question:\n${context}\n\n` : "");

    const fullQuestion =
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (hints.length
        ? "\n\nPearson-preloaded hints / explanations (these may directly contain or strongly suggest the answer):\n- " +
          hints.join("\n- ")
        : "");

    log("LABELING Q:", question);
    log("answer key:", answerKeySlice ? `${answerKeySlice.length} chars` : "(none)");
    log("hints:", hints.length);
    log("etext:", etext && etext.text ? `${etext.text.length} chars` : "(none)");
    log("labels:", labelTexts);
    log("targets:", targetTexts);

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          kind: "labeling",
          question: fullQuestion,
          stablePrefix,
          instructions,
          labels: labelTexts,
          targets: targetTexts,
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

        labelingRoot.scrollIntoView({ block: "center" });
        await sleep(300);

        for (const a of assignments) {
          const labelIdx = Number(a.label);
          const targetIdx = Number(a.target);
          if (
            !Number.isInteger(labelIdx) || labelIdx < 0 || labelIdx >= labels.length ||
            !Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= targets.length
          ) continue;
          const labelEl = labels[labelIdx];
          const targetEl = targets[targetIdx];
          if (!labelEl || !targetEl) continue;
          log(`label "${labelTexts[labelIdx]}" -> "${targetTexts[targetIdx]}"`);
          try {
            await dragItemToBin(labelEl, targetEl);
          } catch (e) {
            console.error("[pearson-bot] label drag failed", e);
          }
        }

        if (autoAdvance) submitAndAdvance(root, "labeling");
      }
    );
  }

  // Shared submit + advance logic (also used by choice handler)
  function submitAndAdvance(root, kind) {
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

      // Track whether this part has been graded yet, and what the result was.
      // We check the .responsesBox that Pearson shows after submit. Pearson
      // writes one of:
      //   .responses.correct   → bot got it right
      //   .responses.exhausted → bot got it wrong (no more attempts)
      //   .responses.incorrect → bot got it wrong (retryable)
      // We only count each part once.
      let resultReported = false;
      const reportResult = (correct) => {
        if (resultReported) return;
        resultReported = true;
        log(correct ? "result: CORRECT" : "result: INCORRECT", `(${kind || "unknown"})`);
        try {
          chrome.runtime.sendMessage({ type: "reportResult", correct, kind: kind || "unknown" });
        } catch (_) {}
      };

      let polls = 0;
      const maxPolls = 12; // ~2.4s
      const poll = async () => {
        if (!(await autoStillOn())) {
          log("auto mode off — stopping poll");
          return;
        }
        polls++;

        // Check for a graded result on the part we just submitted.
        // Pearson writes a .responses.correct or .responses.incorrect/.exhausted
        // div into the part's .responsesBox after grading.
        if (!resultReported) {
          const rb = solvedPartEl.querySelector(".responsesBox");
          if (rb) {
            if (rb.querySelector(".responses.correct")) {
              reportResult(true);
            } else if (rb.querySelector(".responses.exhausted, .responses.incorrect, .responses.partialcredit")) {
              reportResult(false);
            }
          }
        }

        const openParts = Array.from(
          document.querySelectorAll(".sections .section.part.foldy.open")
        ).filter((el) =>
          el.querySelector(".work[type^='solution'], .sorting, .sort-items, .ranking, .rank-items, .vocab, .word-list, .labeling")
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

  // Walk .section.transition blocks that appear BEFORE the current part in
  // document order. Each transition typically holds a clinical-video thumbnail
  // linking to a Pearson media popup. Returns:
  //   - thumbnail data URLs (so vision can read on-screen text in the still)
  //   - the popup URLs themselves (we'll ask the background to fetch them and
  //     extract any transcript / caption text)
  async function collectTransitionContext(currentPartEl) {
    const problem = currentPartEl?.closest(".problem") || document.querySelector(".problem");
    if (!problem) return { images: [], urls: [], labels: [] };

    const all = Array.from(problem.querySelectorAll(".section.transition, .section.part"));
    const idx = all.indexOf(currentPartEl);
    const transitions = (idx >= 0 ? all.slice(0, idx) : all).filter((el) =>
      el.classList.contains("transition")
    );

    const images = [];
    const urls = [];
    const labels = [];

    for (const trans of transitions) {
      // Pull popup URLs out of inline onclick handlers (window.open(...))
      trans.querySelectorAll("a[onclick]").forEach((a) => {
        const oc = a.getAttribute("onclick") || "";
        const m = oc.match(/window\.open\(\s*['"]([^'"]+)['"]/);
        if (m) urls.push(m[1]);
      });

      // Grab any thumbnail images
      const imgs = Array.from(trans.querySelectorAll("img"));
      for (const img of imgs) {
        const alt = (img.alt || img.title || "video thumbnail").trim();
        labels.push(alt);
        const rawSrc = img.currentSrc || img.src;
        if (!rawSrc) continue;
        try {
          const absUrl = new URL(rawSrc, document.baseURI).href;
          const r = await fetch(absUrl, { credentials: "include" });
          if (!r.ok) continue;
          const blob = await r.blob();
          if (blob.size > 4 * 1024 * 1024) continue;
          const dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(blob);
          });
          images.push(dataUrl);
        } catch (_) {}
      }
    }

    return { images, urls, labels };
  }

  // Ask background for the textbook's own answer-key slice for this
  // chapter. Returns a string or "" if no key is available for this book.
  async function fetchAnswerKeyInPage(bookCode, chapterTitle) {
    if (!bookCode) return "";
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fetchAnswerKey", bookCode, chapterTitle },
          (r) => resolve((r && r.ok && r.data && r.data.slice) || "")
        );
      } catch (_) {
        resolve("");
      }
    });
  }

  // Ask background to fetch the eText chapter section relevant to this
  // problem and return its plain text. Cached per inItemLinkURL.
  async function fetchEtextSectionInPage(inItemLinkURL) {
    if (!inItemLinkURL) return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "fetchEtextSection", inItemLinkURL }, (r) =>
          resolve(r && r.ok ? r.data : null)
        );
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Ask the background to fetch + extract text from clinical-video popup pages.
  async function fetchVideoContext(urls) {
    if (!urls || !urls.length) return [];
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "fetchVideoContext", urls }, (r) =>
          resolve(r && r.ok ? r.data : [])
        );
      } catch (_) {
        resolve([]);
      }
    });
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

    const choices = inputs.map((inp, idx) => {
      const lbl =
        document.querySelector(`label[for="${inp.id}"]`) ||
        inp.closest("td, li, tr")?.querySelector("label");
      const text = (lbl?.innerText || lbl?.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text;
      // No text — this is an image-only choice. Describe what we have so
      // the LLM can correlate the choice index with the image content.
      // (collectImages on the broader scope picks up all of them; we just
      // need a non-empty string here so the prompt isn't all blanks.)
      const img = lbl?.querySelector("img") || inp.closest("td, li, tr")?.querySelector("img");
      if (img) {
        const alt = (img.alt || img.getAttribute("aria-label") || "").trim();
        return alt ? `[image: ${alt}]` : `[image choice ${idx + 1}]`;
      }
      return `[choice ${idx + 1} — no text]`;
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

    // Clinical-video transitions: thumbnails (vision) + fetched transcript text
    const trans = await collectTransitionContext(root.closest(".section.part"));
    const videoCtx = await fetchVideoContext(trans.urls);
    const videoTexts = videoCtx
      .filter((v) => v && v.text && v.text.length > 20)
      .map((v) => v.text);
    if (trans.images.length) images.push(...trans.images);

    // eText chapter section — the actual textbook content for this problem
    const etext = await fetchEtextSectionInPage(mainCtx && mainCtx.meta && mainCtx.meta.inItemLinkURL);

    // Textbook answer-key appendix slice — if we have the book's answer
    // key registered, fetch the slice for this chapter. This is the
    // literal author-written answer to every end-of-chapter question.
    const bookCode = (mainCtx && mainCtx.meta && mainCtx.meta.bookCode) || "";
    const chapterTitle = (mainCtx && mainCtx.meta && mainCtx.meta.chapterTitle) || "";
    const answerKeySlice = await fetchAnswerKeyInPage(bookCode, chapterTitle);

    // STABLE PREFIX — same across every question in this chapter, so it
    // hits OpenAI's automatic prompt cache at 25% cost on repeat requests.
    // When we have the textbook answer key for this chapter, skip the
    // eText prose (the answer key IS the authoritative content — no need
    // to pay 2000 extra tokens for surrounding chapter text).
    const useEtext = !answerKeySlice && etext && etext.text;
    const stablePrefix =
      (answerKeySlice
        ? "OFFICIAL TEXTBOOK ANSWER KEY for this chapter (from Appendix A of the textbook — these are the AUTHORITATIVE author-written answers to the end-of-chapter questions; match the current question against the answers in this list and use them whenever they apply):\n" +
          answerKeySlice + "\n\n"
        : "") +
      (useEtext
        ? "Relevant textbook chapter section (authoritative — the answer is somewhere in here):\n" +
          etext.text + "\n\n"
        : "") +
      (context ? `Shared context for this question:\n${context}\n\n` : "") +
      (videoTexts.length
        ? "Text extracted from the clinical video page(s) (transcript / captions / on-page description):\n" +
          videoTexts.map((t, i) => `--- Video ${i + 1} ---\n${t}`).join("\n\n") + "\n\n"
        : "");

    // Per-question (variable) content — must NOT be in the stable prefix.
    const fullQuestion =
      question +
      (imageDescriptions.length
        ? "\n\nImage descriptions:\n- " + imageDescriptions.join("\n- ")
        : "") +
      (trans.labels.length
        ? "\n\nThis problem includes clinical case videos that play between parts. " +
          "Thumbnails are attached as images. Videos: " + trans.labels.join("; ")
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
    log("video transitions:", trans.labels.length, "transcripts:", videoTexts.length);
    log("etext:", etext && etext.text ? `${etext.text.length} chars` : "(none)");
    log("answer key:", answerKeySlice ? `${answerKeySlice.length} chars` : "(none)");

    chrome.runtime.sendMessage(
      {
        type: "askLLM",
        payload: {
          question: fullQuestion,
          stablePrefix,
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

        if (autoAdvance) submitAndAdvance(root, isMulti ? "multi-select" : "radio");
      }
    );
  }

  tryFind();
}
