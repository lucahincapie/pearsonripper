const $ = (id) => document.getElementById(id);
const status = (m) => { $("status").textContent = m; };

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function refreshUsageDisplay() {
  const { monthlyUsage, monthlyCap } = await chrome.storage.local.get([
    "monthlyUsage",
    "monthlyCap",
  ]);
  const month = currentMonthKey();
  const used = (monthlyUsage && monthlyUsage[month]) || 0;
  const cap = monthlyCap || 1000;
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const color = pct >= 95 ? "#c00" : pct >= 80 ? "#c80" : "#444";
  $("usage").innerHTML =
    `<div style="color:${color}"><b>${used}</b> / ${cap} questions used this month</div>` +
    `<div style="height:4px;background:#eee;border-radius:2px;margin-top:3px;overflow:hidden">` +
    `<div style="height:100%;width:${pct}%;background:${color}"></div>` +
    `</div>`;
}

async function refreshLicenseDisplay() {
  const { license, licenseValidUntil, licensePlan } = await chrome.storage.local.get([
    "license",
    "licenseValidUntil",
    "licensePlan",
  ]);
  if (license) $("license").value = license;
  const el = $("licenseStatus");
  if (!license) {
    el.textContent = "No license — bot disabled.";
    el.style.color = "#888";
    return;
  }
  if (!licenseValidUntil || licenseValidUntil < Date.now()) {
    el.textContent = "License expired or unverified. Click Activate.";
    el.style.color = "#c00";
    return;
  }
  const days = Math.max(0, Math.ceil((licenseValidUntil - Date.now()) / 86400000));
  el.textContent = `${licensePlan || "Active"} — renews in ${days} day${days === 1 ? "" : "s"}`;
  el.style.color = "#0a0";
}

(async () => {
  const { apiKey, model, autoMode } = await chrome.storage.local.get([
    "apiKey",
    "model",
    "autoMode",
  ]);
  if (apiKey) $("key").value = apiKey;
  if (model) $("model").value = model;
  updateAutoButton(!!autoMode);
  refreshUsageDisplay();
  refreshLicenseDisplay();
})();

$("activate").onclick = async () => {
  const license = $("license").value.trim();
  if (!license) {
    status("Enter a license key first.");
    return;
  }
  status("Activating...");
  chrome.runtime.sendMessage({ type: "validateLicense", license }, (resp) => {
    if (resp && resp.ok) {
      status(`Activated: ${resp.plan}`);
      refreshLicenseDisplay();
    } else {
      status("Activation failed: " + (resp && resp.error ? resp.error : "unknown error"));
    }
  });
};

function updateAutoButton(on) {
  $("autoToggle").textContent = on ? "Stop Auto Mode" : "Start Auto Mode";
  $("autoToggle").style.background = on ? "#ffd6d6" : "";
}

$("save").onclick = async () => {
  const apiKey = $("key").value.trim();
  const model = $("model").value;
  if (!apiKey.startsWith("sk-")) {
    status("Key should start with sk-");
    return;
  }
  await chrome.storage.local.set({ apiKey, model });
  status("Saved.");
};

$("solve").onclick = () => {
  chrome.runtime.sendMessage({ type: "trigger", autoAdvance: false });
  status("Solving...");
};

$("solveNext").onclick = () => {
  chrome.runtime.sendMessage({ type: "trigger", autoAdvance: true });
  status("Solving + advancing...");
};

$("autoToggle").onclick = async () => {
  const { autoMode } = await chrome.storage.local.get(["autoMode"]);
  const turningOn = !autoMode;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage(
    { type: "setAuto", on: turningOn, tabId: tab?.id },
    () => {
      updateAutoButton(turningOn);
      status(turningOn ? "Auto mode ON" : "Auto mode OFF");
    }
  );
};

// Live-update the button if auto mode turns itself off
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoMode) updateAutoButton(!!changes.autoMode.newValue);
  if (changes.monthlyUsage) refreshUsageDisplay();
  if (changes.licenseValidUntil || changes.license || changes.licensePlan) {
    refreshLicenseDisplay();
  }
});
