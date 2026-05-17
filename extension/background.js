// ============================================================
// Coursepilot — unified service worker
// ============================================================
// Owns:
//   - Shared licensing (Cloudflare worker + master key)
//   - First-run onboarding tab
//   - Toolbar badge reflecting enabled state
//   - Central message router that delegates to:
//       * pearson-handlers.js (Pearson MyLab)
//       * mh-content.js (McGraw Recharge — runs in tab as content script)
//   - Keyboard commands routed to whichever platform owns the active tab
// ============================================================

importScripts("pearson-handlers.js");

// ---- License -----------------------------------------------------------
// Replace with your Cloudflare Worker URL after deploying.
const LICENSE_SERVER = "https://coursepilot-license.YOUR-SUBDOMAIN.workers.dev";

// Hardcoded master key — bypasses the server entirely. Owner/dev use only.
// Rotate this to a private value before publishing v1.0.
const MASTER_LICENSE = "COURSEPILOT-DEV-FOREVER";

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
  if (license === MASTER_LICENSE) {
    await chrome.storage.local.set({
      license,
      licensePlan: "Owner",
      monthlyCap: 999999,
      licenseValidUntil: Date.now() + 100 * 365 * 86400000,
      licenseLastChecked: Date.now(),
    });
    return { plan: "Owner", monthlyCap: 999999 };
  }
  const deviceId = await getDeviceId();
  let res;
  try {
    res = await fetch(`${LICENSE_SERVER}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license, deviceId, product: "coursepilot" }),
    });
  } catch (e) {
    throw new Error("Cannot reach license server");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.valid) {
    throw new Error(data.error || `Invalid license (HTTP ${res.status})`);
  }
  await chrome.storage.local.set({
    license,
    licensePlan: data.plan || "Active",
    monthlyCap: data.monthlyCap || 1000,
    licenseValidUntil: data.validUntil || Date.now() + 86400000,
    licenseLastChecked: Date.now(),
  });
  return { plan: data.plan, monthlyCap: data.monthlyCap };
}

// Used by askOpenAI in pearson-handlers.js — must exist on the global scope.
// eslint-disable-next-line no-unused-vars
async function ensureLicenseValid() {
  const { license, licenseValidUntil, licenseLastChecked } =
    await chrome.storage.local.get([
      "license",
      "licenseValidUntil",
      "licenseLastChecked",
    ]);
  if (!license) throw new Error("No license. Activate one in the popup.");
  if (license === MASTER_LICENSE) return true;
  const now = Date.now();
  if (
    licenseValidUntil &&
    licenseValidUntil > now &&
    licenseLastChecked &&
    now - licenseLastChecked < 24 * 60 * 60 * 1000
  ) {
    return true;
  }
  await validateLicense(license);
  return true;
}

// ---- Badge --------------------------------------------------------------
function paintBadge(on) {
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#2ecc71" : "#5f6368" });
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled || changes.autoMode) {
    chrome.storage.local.get(["enabled", "autoMode"]).then((d) => {
      paintBadge(!!d.enabled || !!d.autoMode);
    });
  }
});
chrome.storage.local.get(["enabled", "autoMode"]).then((d) => paintBadge(!!d.enabled || !!d.autoMode));

// ---- Install + onboarding ----------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get([
    "enabled",
    "autoSubmit",
    "confidence",
    "humanlike",
    "model",
  ]);
  await chrome.storage.local.set({
    enabled: cur.enabled === true,
    autoSubmit: cur.autoSubmit !== false,
    confidence: cur.confidence || "high",
    humanlike: cur.humanlike !== false,
    model: cur.model || "gpt-4.1",
  });
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

// ---- Active-tab platform detection -------------------------------------
function platformForUrl(url) {
  if (!url) return null;
  if (/learning\.mheducation\.com/.test(url)) return "mh";
  if (/(pearson|pearsoned)\.com/.test(url)) return "pearson";
  return null;
}

async function activePlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { platform: platformForUrl(tab && tab.url), tab };
  } catch {
    return { platform: null, tab: null };
  }
}

// ---- Keyboard commands -------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  const { platform, tab } = await activePlatform();
  if (!tab || !tab.id) return;
  if (platform === "mh") {
    if (command === "solve-question") chrome.tabs.sendMessage(tab.id, { type: "solveNow" });
  } else if (platform === "pearson") {
    if (command === "solve-question") runSolve(false);
    else if (command === "solve-and-next") runSolve(true);
  }
});

// ---- Central message router --------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ---- Shared license ----
  if (msg.type === "validateLicense") {
    validateLicense(msg.license)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "checkLicense") {
    ensureLicenseValid()
      .then(() => sendResponse({ valid: true }))
      .catch((e) => sendResponse({ valid: false, reason: String(e.message || e) }));
    return true;
  }
  if (msg.type === "openOnboarding") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    sendResponse({ ok: true });
    return;
  }

  // ---- Pearson: set Dojo dijit widget value (runs in MAIN world to access window.dijit) ----
  if (msg.type === "setDijitValue") {
    const tabId = _sender.tab && _sender.tab.id;
    const frameId = _sender.frameId;
    if (!tabId) {
      sendResponse({ ok: false, error: "no tabId" });
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: frameId != null ? [frameId] : undefined, allFrames: frameId == null },
        world: "MAIN",
        func: (widgetId, value, optionIndex) => {
          try {
            // Get the dijit registry — try AMD require first since Pearson uses AMD
            let registry = null;
            if (window.require && typeof window.require === "function") {
              try {
                const r = window.require("dijit/registry");
                if (r && r.byId) registry = r;
              } catch (_) {}
            }
            if (!registry && window.dijit && window.dijit.registry) registry = window.dijit.registry;
            if (!registry && window.dijit && window.dijit.byId) registry = window.dijit;
            if (!registry || !registry.byId) return { ok: false, reason: "no registry" };

            const w = registry.byId(widgetId);
            if (!w) return { ok: false, reason: "no widget" };

            // xl.player.controls.Fillin — set selectedIndex (the real state field)
            // plus value, then notify the controls/grading system.
            try {
              if (typeof w.set === "function") {
                w.set("selectedIndex", optionIndex);
                try { w.set("value", value); } catch (_) {}
              } else {
                w.selectedIndex = optionIndex;
              }
              // Notify the grading framework
              try { if (typeof w.updateControlState === "function") w.updateControlState(); } catch (_) {}
              try { if (typeof w.answeredCommand === "function") w.answeredCommand(); } catch (_) {}
              try { if (typeof w.answerAppliedCommand === "function") w.answerAppliedCommand(); } catch (_) {}
              // Verify selection took
              const got = w.selectedIndex;
              return { ok: true, method: "selectedIndex", selectedIndex: got };
            } catch (e) {
              return { ok: false, reason: "set failed: " + e.message };
            }
          } catch (e) {
            return { ok: false, reason: String(e.message || e) };
          }
        },
        args: [msg.widgetId, msg.value, msg.optionIndex],
      })
      .then((results) => {
        const r = results && results[0] && results[0].result;
        sendResponse(r || { ok: false, reason: "no result" });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // ---- Pearson handlers ----
  if (msg.type === "trigger") {
    runSolve(!!msg.autoAdvance);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "askLLM") {
    askOpenAI(msg.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "setAuto") {
    setAutoMode(!!msg.on, msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "noQuestion") {
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
  if (msg.type === "reportResult") {
    chrome.storage.local
      .get(["statsCorrect", "statsTotal", "statsByKind"])
      .then(({ statsCorrect = 0, statsTotal = 0, statsByKind = {} }) => {
        const kind = msg.kind || "unknown";
        const prev = statsByKind[kind] || { correct: 0, total: 0 };
        statsByKind[kind] = {
          correct: prev.correct + (msg.correct ? 1 : 0),
          total: prev.total + 1,
        };
        chrome.storage.local.set({
          statsCorrect: statsCorrect + (msg.correct ? 1 : 0),
          statsTotal: statsTotal + 1,
          statsByKind,
        });
      });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "fetchAnswerKey") {
    fetchAnswerKey(msg.bookCode)
      .then((ak) => {
        if (!ak) return sendResponse({ ok: true, data: null });
        const slice = getAnswerKeyForChapterTitle(ak, msg.chapterTitle);
        sendResponse({
          ok: true,
          data: { slice, chaptersAvailable: Object.keys(ak.byChapter || {}).map(Number) },
        });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "fetchEtextSection") {
    const tabUrl = (_sender.tab && _sender.tab.url) || "";
    const host = (() => {
      try {
        return new URL(tabUrl).host;
      } catch {
        return "";
      }
    })();
    fetchEtextSection(msg.inItemLinkURL, host)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "fetchVideoContext") {
    fetchVideoContext(msg.urls || [])
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
