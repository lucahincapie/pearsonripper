// ============================================================
// MH Recharge Helper — main world interceptor
// ============================================================
// This file runs in the page's main JS world (not the content script
// isolated world) so it can hook window.fetch and XMLHttpRequest before
// the Angular app makes its network calls. Every assessment-items/*.json
// response is intercepted, the hidata payload is decoded, and the
// resulting question state is forwarded to the content script via
// window.postMessage.
//
// The decoder is reverse-engineered from McGraw Hill's own bundle:
//   const le = payload.replace(/(.)(.)(.)(.)(.)(.)(.)(.)(.)/g, "$2$6$8$1$4$9$3$5$7").replace(/ +$/, "");
//   const json = JSON.parse(b64DecodeUnicode(le));
// It's a 9-character permutation followed by base64 + UTF-8 decode.
// No real crypto. The "key" is hardcoded in their JS bundle.
// ============================================================

(() => {
  if (window.__mhrh_installed) return;
  window.__mhrh_installed = true;

  const TAG = "[mhrh]";
  const log = (...a) => console.log("%c" + TAG, "color:#0a0;font-weight:bold", ...a);

  // -------- decoder ----------------------------------------------------
  function b64DecodeUnicode(str) {
    // McGraw's b64DecodeUnicode equivalent — handles UTF-8 in base64.
    try {
      return decodeURIComponent(
        atob(str)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
    } catch (e) {
      return null;
    }
  }

  function decodeHidata(payload) {
    if (!payload || typeof payload !== "string") return null;
    try {
      const permuted = payload
        .replace(/(.)(.)(.)(.)(.)(.)(.)(.)(.)/g, "$2$6$8$1$4$9$3$5$7")
        .replace(/ +$/, "");
      const text = b64DecodeUnicode(permuted);
      if (!text) return null;
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // -------- normalization ----------------------------------------------
  // The DOM stem and the JSON prompt aren't byte-identical (HTML, blanks,
  // whitespace). We strip tags, lowercase, collapse whitespace, and turn
  // any "blank" placeholder into a single token so they line up.
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
      .replace(/_+/g, " ") // visible blank underscores in DOM
      .replace(/\bblank\b/gi, " ") // _visuallyHidden "Blank" word
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // -------- cache -------------------------------------------------------
  // stemNorm -> { correctTexts: [normalized choice text...], raw }
  // Stored on window so the content script (isolated world) can poll it
  // via DOM events too, but the primary path is postMessage.
  window.__mhrh_cache = window.__mhrh_cache || new Map();

  function ingestItem(item, sourceUrl) {
    if (!item || typeof item !== "object") return;
    const decoded = decodeHidata(item.hidata && item.hidata.payload);
    if (!decoded) return;

    const stemNorm = normalizeText(decoded.prompt);
    if (!stemNorm) return;

    const choices = decoded.choices || [];

    // Multiple choice: decoded.answer is a single UUID string.
    // Multi-select (MULTIPLE_CHOICE_MULTI_SELECT): decoded.answers is
    // an array of UUID strings. Both map to choices[].key.
    let answerKeys = [];
    if (Array.isArray(decoded.answer)) {
      answerKeys = decoded.answer;
    } else if (typeof decoded.answer === "string") {
      answerKeys = [decoded.answer];
    } else if (Array.isArray(decoded.answers) && decoded.answers.every((x) => typeof x === "string")) {
      // Only treat as MC keys if choices actually use these as keys —
      // otherwise this is the FITB/ORDERING shape we handle elsewhere.
      const choiceKeys = new Set(choices.map((c) => c && c.key).filter(Boolean));
      if (choiceKeys.size && decoded.answers.some((k) => choiceKeys.has(k))) {
        answerKeys = decoded.answers;
      }
    }

    const correctTexts = [];
    for (const c of choices) {
      if (answerKeys.includes(c.key)) {
        correctTexts.push(normalizeText(c.content));
      }
    }

    // TRUE_FALSE: decoded.answer is the literal string "true" or "false".
    // No `choices` array — the DOM provides the True/False rows directly.
    if (
      (item.type || decoded.type) === "TRUE_FALSE" &&
      typeof decoded.answer === "string"
    ) {
      const v = decoded.answer.trim().toLowerCase();
      if (v === "true" || v === "false") {
        correctTexts.push(v);
      }
    }

    // Some types use "correct" boolean inside choices instead.
    if (correctTexts.length === 0) {
      for (const c of choices) {
        if (c.correct === true || c.isCorrect === true) {
          correctTexts.push(normalizeText(c.content));
        }
      }
    }

    // For fill-in-the-blank, decoded.answers is an array of:
    //   { values: ["accepted1", "accepted2"], response: "<uuid>", rationale: [...] }
    // Each entry corresponds to one blank in the prompt, identified by
    // ${response:<uuid>} placeholders. We keep them paired so the content
    // script can fill multi-blank questions correctly.
    let blankAnswers = []; // legacy flat list — keep for back-compat
    let blanks = []; // [{ response, values, primary }]
    if (typeof decoded.answer === "string" && choices.length === 0) {
      blankAnswers.push(decoded.answer);
      blanks.push({ response: null, values: [decoded.answer], primary: decoded.answer });
    }
    if (Array.isArray(decoded.answers)) {
      for (const a of decoded.answers) {
        if (typeof a === "string") {
          blankAnswers.push(a);
          blanks.push({ response: null, values: [a], primary: a });
        } else if (a && Array.isArray(a.values)) {
          for (const v of a.values) blankAnswers.push(v);
          blanks.push({
            response: a.response || null,
            values: a.values.slice(),
            primary: a.values[0],
          });
        } else if (a && typeof a.text === "string") {
          blankAnswers.push(a.text);
          blanks.push({ response: a.response || null, values: [a.text], primary: a.text });
        }
      }
    }

    // ORDERING: decoded.answers (plural!) is an array of UUIDs in the
    // correct order. Choices use a `text` field instead of `content`.
    // We surface the ordered key list and a key→text map so the content
    // script can reorder DOM items.
    let orderedKeys = null;
    let choiceTextByKey = null;
    if (
      (item.type || decoded.type) === "ORDERING" &&
      (Array.isArray(decoded.answers) || Array.isArray(decoded.answer))
    ) {
      const ordered = Array.isArray(decoded.answers) ? decoded.answers : decoded.answer;
      // Only treat as ordering if entries are bare UUID strings, not
      // the {values, response} objects used for FITB.
      if (ordered.every((x) => typeof x === "string")) {
        orderedKeys = ordered.slice();
        choiceTextByKey = {};
        for (const c of choices) {
          if (!c || !c.key) continue;
          choiceTextByKey[c.key] = normalizeText(c.text || c.content || "");
        }
      }
    }

    // MATCHING: decoded.prompts (left labels), decoded.choices (right
    // draggables), decoded.answers (array of { prompt: <key>, choices: [<key>] }).
    // Pre-compute prompt-key -> correct-choice-key for the content script.
    let matching = null;
    if ((item.type || decoded.type) === "MATCHING" && Array.isArray(decoded.answers) && Array.isArray(decoded.prompts)) {
      const promptToChoice = {};
      for (const a of decoded.answers) {
        if (a && a.prompt && Array.isArray(a.choices) && a.choices.length) {
          promptToChoice[a.prompt] = a.choices[0];
        }
      }
      matching = {
        promptToChoice,
        prompts: decoded.prompts.map((p) => ({ key: p.key, text: normalizeText(p.content) })),
        choices: decoded.choices.map((c) => ({ key: c.key, text: normalizeText(c.content) })),
      };
    }

    const entry = {
      stemNorm,
      stemRaw: decoded.prompt,
      type: item.type || decoded.type || "UNKNOWN",
      correctTexts,
      blankAnswers,
      blanks,
      orderedKeys,
      choiceTextByKey,
      matching,
      caseSensitive: !!decoded.caseSensitive,
      itemId: item.id,
      sourceUrl,
      raw: decoded,
    };

    window.__mhrh_cache.set(stemNorm, entry);
    log(
      "cached",
      entry.type,
      "->",
      correctTexts.length ? correctTexts : blanks.map((b) => b.primary),
      "from",
      item.id
    );

    // Forward to content script. Angular's Zone.js postMessage interceptor
    // requires a `type` field on the message data, so we add one.
    try {
      window.postMessage(
        { type: "mhrh", __mhrh: true, kind: "item", entry: serializeEntry(entry) },
        "*"
      );
    } catch (e) {
      // ignore — content script also polls window.__mhrh_cache directly
    }
  }

  function serializeEntry(e) {
    return {
      stemNorm: e.stemNorm,
      stemRaw: e.stemRaw,
      type: e.type,
      correctTexts: e.correctTexts,
      blankAnswers: e.blankAnswers,
      blanks: e.blanks,
      orderedKeys: e.orderedKeys,
      choiceTextByKey: e.choiceTextByKey,
      matching: e.matching,
      caseSensitive: e.caseSensitive,
      itemId: e.itemId,
      sourceUrl: e.sourceUrl,
    };
  }

  function maybeIngestResponseBody(url, bodyText) {
    if (!url || !bodyText) return;
    if (!/(?:assessment-items|resources)\/[^/]+\.json/.test(url)) return;
    let item;
    try {
      item = JSON.parse(bodyText);
    } catch {
      return;
    }
    ingestItem(item, url);
  }

  // Expose for debugging + backfill
  window.__mhrh_ingest = ingestItem;
  window.__mhrh_ingestUrl = async function (url) {
    try {
      const r = await origFetch.call(window, url, { credentials: "include" });
      const j = await r.json();
      ingestItem(j, url);
      return true;
    } catch (e) {
      log("ingestUrl failed", e);
      return false;
    }
  };

  // -------- fetch hook --------------------------------------------------
  // NewRelic and other monitors wrap window.fetch *after* we do, so we
  // re-install our wrapper periodically and tag it so we can detect when
  // it's been overwritten.
  let origFetch = window.fetch;
  function makeFetchWrapper(inner) {
    const wrapper = async function (...args) {
      const res = await inner.apply(this, args);
      try {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : (args[0] && args[0].url) || "";
        if (/(?:assessment-items|resources)\/[^/]+\.json/.test(url)) {
          const clone = res.clone();
          clone
            .text()
            .then((body) => maybeIngestResponseBody(url, body))
            .catch(() => {});
        }
      } catch {}
      return res;
    };
    wrapper.__mhrh_hooked = true;
    return wrapper;
  }
  window.fetch = makeFetchWrapper(origFetch);
  // Re-install if anything else (NewRelic, Pendo, etc) wraps over us.
  setInterval(() => {
    if (!window.fetch || !window.fetch.__mhrh_hooked) {
      origFetch = window.fetch;
      window.fetch = makeFetchWrapper(origFetch);
      log("re-wrapped fetch (was overridden by another script)");
    }
  }, 500);

  // -------- XHR hook ----------------------------------------------------
  const OX = XMLHttpRequest.prototype.open;
  const OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mhrh_url = url;
    return OX.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        maybeIngestResponseBody(this.__mhrh_url, this.responseText);
      } catch {}
    });
    return OS.apply(this, arguments);
  };

  // -------- backfill: re-fetch assessment-items already loaded ---------
  // If the extension was reloaded mid-assignment, the current question's
  // JSON has already been fetched by Angular and we never saw it. Walk
  // performance entries and re-fetch any matching URL — these are static
  // CDN files so the request is cheap and idempotent.
  const backfillSeen = new Set();
  function backfillFromPerf() {
    try {
      const urls = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => /(?:assessment-items|resources)\/[^/]+\.json/.test(n));
      let added = 0;
      for (const url of urls) {
        if (backfillSeen.has(url)) continue;
        backfillSeen.add(url);
        added++;
        origFetch
          .call(window, url, { credentials: "include" })
          .then((r) => r.json())
          .then((j) => ingestItem(j, url))
          .catch(() => {});
      }
      if (added) log("backfill: refetching", added, "new items");
    } catch (e) {
      log("backfill failed", e);
    }
  }
  backfillFromPerf();
  // Re-scan continuously so new questions get caught even if our fetch
  // hook gets stomped. Static CDN files, so re-fetch is cheap.
  setInterval(backfillFromPerf, 1000);

  // -------- content-script -> main-world bridge -----------------------
  // The content script may ask us to look up an entry by stem text or
  // dump the cache. We listen for postMessages with __mhrh_query.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || !m.__mhrh_query) return;
    if (m.kind === "lookup") {
      const stemNorm = m.stemNorm;
      const entry = window.__mhrh_cache.get(stemNorm);
      window.postMessage(
        { type: "mhrh", __mhrh: true, kind: "lookupResult", reqId: m.reqId, entry: entry ? serializeEntry(entry) : null },
        "*"
      );
    } else if (m.kind === "dump") {
      const all = [];
      for (const e of window.__mhrh_cache.values()) all.push(serializeEntry(e));
      window.postMessage({ type: "mhrh", __mhrh: true, kind: "dumpResult", reqId: m.reqId, entries: all }, "*");
    }
  });

  log("installed (decoder + hooks ready)");
})();
