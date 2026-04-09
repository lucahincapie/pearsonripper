// ============================================================
// Coursepilot — popup
// ============================================================
// Detects which platform is in the active tab (mh / pearson / none)
// and adapts the UI:
//   - mh: Start/Stop button toggles `enabled` storage flag
//   - pearson: Start/Stop button toggles `autoMode` storage flag and
//     calls into background to start/stop the auto-runner
//   - none: warning shown, controls disabled
// Shared across both: license card, settings, stats, recent activity.
// ============================================================

const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  MULTIPLE_CHOICE: "Multiple choice",
  MULTIPLE_CHOICE_MULTI_SELECT: "Multi select",
  MULTI_SELECT: "Multi select",
  FILL_IN_THE_BLANK: "Fill in blank",
  FILL_IN_BLANK: "Fill in blank",
  TRUE_FALSE: "True / false",
  ORDERING: "Ordering",
  MATCHING: "Matching",
  UNKNOWN: "Other",
  // Pearson kinds
  radio: "Radio",
  checkbox: "Checkbox",
  sorting: "Sorting",
  ranking: "Ranking",
  vocab: "Vocab",
};

let activePlatform = null; // 'mh' | 'pearson' | null
let activeTabId = null;

function platformForUrl(url) {
  if (!url) return null;
  if (/learning\.mheducation\.com/.test(url)) return "mh";
  if (/(pearson|pearsoned)\.com/.test(url)) return "pearson";
  return null;
}

function paintStartStop(on) {
  const btn = $("startStop");
  $("startStopLabel").textContent = on ? "Stop" : "Start";
  btn.querySelector(".icon").textContent = on ? "■" : "▶";
  btn.classList.toggle("start", !on);
  btn.classList.toggle("stop", on);
}

function paintPlatformBadge() {
  const el = $("platformBadge");
  el.classList.remove("mh", "pearson");
  if (activePlatform === "mh") {
    el.textContent = "Recharge";
    el.classList.add("mh");
  } else if (activePlatform === "pearson") {
    el.textContent = "MyLab";
    el.classList.add("pearson");
  } else {
    el.textContent = "—";
  }
}

function paintStatus(status) {
  const line = $("statusLine");
  const text = $("statusText");
  if (!status) {
    line.className = "status-line stopped";
    text.textContent = activePlatform ? "Stopped" : "No supported page";
    return;
  }
  const stale = Date.now() - (status.at || 0) > 60_000;
  const state = stale ? "idle" : status.state || "idle";
  line.className = "status-line " + state;
  text.textContent = status.detail || state;
}

function paintLicense(license, validUntil, plan) {
  const card = $("licenseCard");
  const dot = $("licenseStatusDot");
  const status = $("licenseStatus");
  const startBtn = $("startStop");
  const now = Date.now();
  const isMaster = license === "COURSEPILOT-DEV-FOREVER";
  const valid = license && (isMaster || (validUntil && validUntil > now));
  if (valid) {
    card.classList.add("active");
    dot.className = "license-dot active";
    if (isMaster) {
      status.textContent = "Owner key";
    } else {
      const days = Math.max(0, Math.ceil((validUntil - now) / 86400000));
      status.textContent = `${plan || "Active"} — ${days} day${days === 1 ? "" : "s"} left`;
    }
    status.className = "license-status active";
    if (activePlatform) startBtn.disabled = false;
  } else if (license) {
    card.classList.remove("active");
    dot.className = "license-dot expired";
    status.textContent = "License expired — re-activate";
    status.className = "license-status expired";
    startBtn.disabled = true;
  } else {
    card.classList.remove("active");
    dot.className = "license-dot";
    status.textContent = "No license — activate to start";
    status.className = "license-status";
    startBtn.disabled = true;
  }
}

function colorForPct(pct) {
  if (pct >= 90) return "#2ecc71";
  if (pct >= 75) return "#f39c12";
  return "#e74c3c";
}

async function refreshStats() {
  const data = await chrome.storage.local.get([
    "gradedTotal",
    "gradedCorrect",
    "perType",
    "solvedCount",
    "recentActivity",
    // Pearson stats compatibility
    "statsCorrect",
    "statsTotal",
    "statsByKind",
  ]);

  // Coursepilot writes to gradedTotal/gradedCorrect; pearson writes to
  // statsCorrect/statsTotal. Sum them so the popup shows lifetime totals
  // across both platforms.
  const total = (data.gradedTotal || 0) + (data.statsTotal || 0);
  const correct = (data.gradedCorrect || 0) + (data.statsCorrect || 0);
  $("solvedCount").textContent = data.solvedCount || total || 0;

  if (total === 0) {
    $("accBig").innerHTML = `—`;
    $("accBar").style.width = "0";
  } else {
    const pct = Math.round((correct / total) * 100);
    const color = colorForPct(pct);
    $("accBig").innerHTML =
      `<span style="color:${color}">${pct}%</span> ` +
      `<span style="font-size:11px;color:#9aa0a6;font-weight:400">${correct}/${total}</span>`;
    $("accBar").style.width = pct + "%";
    $("accBar").style.background = color;
  }

  // Merged per-type breakdown
  const merged = { ...(data.perType || {}) };
  for (const [k, v] of Object.entries(data.statsByKind || {})) {
    merged[k] = merged[k] || { total: 0, correct: 0 };
    merged[k].total += v.total || 0;
    merged[k].correct += v.correct || 0;
  }
  const types = Object.keys(merged).sort();
  const bd = $("breakdown");
  if (types.length === 0) {
    bd.innerHTML = "";
  } else {
    bd.innerHTML = types
      .map((t) => {
        const s = merged[t];
        const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
        const color = colorForPct(pct);
        const label = TYPE_LABELS[t] || t.toLowerCase().replace(/_/g, " ");
        return `<div class="type-row">
          <div class="type-label">${label}</div>
          <div class="type-pct" style="color:${color}">${pct}%</div>
          <div class="type-count">${s.correct}/${s.total}</div>
        </div>`;
      })
      .join("");
  }

  // Recent activity (Coursepilot's) — pearson side doesn't write to it yet
  const recent = (data.recentActivity || []).slice().reverse();
  const list = $("activityList");
  if (recent.length === 0) {
    list.innerHTML = `<div class="activity-empty">No questions graded yet.</div>`;
  } else {
    list.innerHTML = recent
      .map(
        (a) => `<div class="activity-item">
          <div class="activity-icon ${a.ok ? "ok" : "bad"}">${a.ok ? "✓" : "✗"}</div>
          <div class="activity-text" title="${escapeAttr(a.stem)}">${escapeHtml(a.stem) || "(no stem)"}</div>
        </div>`
      )
      .join("");
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ---- Init -------------------------------------------------------------
(async () => {
  // Detect active tab platform
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && tab.id;
  activePlatform = platformForUrl(tab && tab.url);
  paintPlatformBadge();
  if (!activePlatform) {
    $("platformWarn").style.display = "block";
    $("startStop").style.display = "none";
    $("statusLine").style.display = "none";
  }

  const data = await chrome.storage.local.get([
    "enabled",
    "autoMode",
    "autoSubmit",
    "confidence",
    "humanlike",
    "apiKey",
    "model",
    "status",
    "license",
    "licenseValidUntil",
    "licensePlan",
  ]);

  // For Recharge "enabled" toggles solving; for Pearson "autoMode" does.
  const isOn = activePlatform === "pearson" ? !!data.autoMode : !!data.enabled;
  paintStartStop(isOn);
  $("autoSubmit").checked = data.autoSubmit !== false;
  $("humanlike").checked = data.humanlike !== false;
  $("confidence").value = data.confidence || "high";
  if (data.apiKey) $("apiKey").value = data.apiKey;
  $("model").value = data.model || "gpt-4.1";

  paintLicense(data.license, data.licenseValidUntil, data.licensePlan);
  paintStatus(isOn ? data.status : null);
  refreshStats();

  // Hide Pearson-only settings on Recharge tabs and vice versa
  if (activePlatform === "mh") {
    $("apiKeyRow").style.display = "none";
    $("modelRow").style.display = "none";
  } else if (activePlatform === "pearson") {
    document.querySelector('label[for="confidence"]').parentElement.style.display = "none";
  }
})();

// ---- Start/Stop -------------------------------------------------------
$("startStop").onclick = async () => {
  if (!activePlatform) return;
  if (activePlatform === "mh") {
    const { enabled = false } = await chrome.storage.local.get(["enabled"]);
    const next = !enabled;
    await chrome.storage.local.set({ enabled: next });
    paintStartStop(next);
    if (next && activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: "solveNow" }, () => {});
    }
  } else if (activePlatform === "pearson") {
    const { autoMode = false } = await chrome.storage.local.get(["autoMode"]);
    const next = !autoMode;
    chrome.runtime.sendMessage(
      { type: "setAuto", on: next, tabId: activeTabId },
      () => {
        paintStartStop(next);
      }
    );
  }
};

// ---- Settings panel ---------------------------------------------------
$("settingsToggle").onclick = () => {
  $("settings").classList.toggle("open");
};
$("autoSubmit").onchange = async () => {
  await chrome.storage.local.set({ autoSubmit: $("autoSubmit").checked });
};
$("humanlike").onchange = async () => {
  await chrome.storage.local.set({ humanlike: $("humanlike").checked });
};
$("confidence").onchange = async () => {
  await chrome.storage.local.set({ confidence: $("confidence").value });
};
$("apiKey").onchange = async () => {
  const v = $("apiKey").value.trim();
  if (v && !v.startsWith("sk-")) return;
  await chrome.storage.local.set({ apiKey: v });
};
$("model").onchange = async () => {
  await chrome.storage.local.set({ model: $("model").value });
};

// ---- License activation -----------------------------------------------
$("licenseActivate").onclick = async () => {
  const key = $("licenseInput").value.trim().toUpperCase();
  const err = $("licenseError");
  err.textContent = "";
  if (!key) {
    err.textContent = "Enter a license key.";
    return;
  }
  $("licenseActivate").disabled = true;
  $("licenseActivate").textContent = "Checking…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "validateLicense", license: key });
    if (resp && resp.ok) {
      const { license, licenseValidUntil, licensePlan } = await chrome.storage.local.get([
        "license",
        "licenseValidUntil",
        "licensePlan",
      ]);
      paintLicense(license, licenseValidUntil, licensePlan);
      err.textContent = "";
    } else {
      err.textContent = (resp && resp.error) || "Activation failed.";
    }
  } catch (e) {
    err.textContent = "Cannot reach license server.";
  } finally {
    $("licenseActivate").disabled = false;
    $("licenseActivate").textContent = "Activate";
  }
};
$("licenseInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("licenseActivate").click();
});

// ---- Live storage updates ---------------------------------------------
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled && activePlatform === "mh") paintStartStop(!!changes.enabled.newValue);
  if (changes.autoMode && activePlatform === "pearson") paintStartStop(!!changes.autoMode.newValue);
  if (changes.status) paintStatus(changes.status.newValue);
  if (changes.license || changes.licenseValidUntil || changes.licensePlan) {
    chrome.storage.local
      .get(["license", "licenseValidUntil", "licensePlan"])
      .then((d) => paintLicense(d.license, d.licenseValidUntil, d.licensePlan));
  }
  if (
    changes.gradedTotal ||
    changes.gradedCorrect ||
    changes.solvedCount ||
    changes.perType ||
    changes.recentActivity ||
    changes.statsTotal ||
    changes.statsCorrect ||
    changes.statsByKind
  ) {
    refreshStats();
  }
});
