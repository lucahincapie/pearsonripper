# Pearson Review Helper — Setup & Operations Guide

This is the full operational doc for running Pearson Review Helper as a paid product. Copy this whole file into a Google Doc for easy sharing/editing.

---

## 1. What you have

- **`extension/`** — the Chrome extension users install
- **License server (Cloudflare Worker)** — code in section 4 of this doc, you'll deploy it yourself
- **Manual billing** — Venmo / Zelle / Cash App for now, Stripe later

---

## 2. Customer onboarding flow

This is the end-to-end flow for getting a paying customer up and running.

1. **Customer pays you $14.99** via Venmo/Zelle (or whatever method)
2. **You issue a license key** by adding it to your Cloudflare Worker's KV store (see section 4.4)
3. **You email the customer**:
   - A zip of the `extension/` folder
   - Their license key (e.g. `PRH-A7K9-MN3B-2X4P`)
   - The "Customer install instructions" from section 6 of this doc
4. Customer pastes their license key + their own OpenAI API key into the extension popup → clicks Activate → starts solving

---

## 3. Pricing tiers

| Plan | Price/mo | Questions/mo | Recommended models |
|---|---|---|---|
| Lite | $4.99 | 200 | gpt-4o-mini |
| Standard | $14.99 | 1,000 | gpt-4o |
| Pro | $29.99 | 5,000 | gpt-4.1, o1 |

These caps are enforced by the extension reading `monthlyCap` from your license server's response. You set the cap per-license when you create it.

---

## 4. Deploying the license server (Cloudflare Worker)

This is the backend that validates license keys. You'll deploy it once and it'll handle all your customers. Free tier covers ~100k requests/day, which is way more than you'll need.

### 4.1 Sign up for Cloudflare

Go to https://dash.cloudflare.com/sign-up → create a free account.

### 4.2 Install Wrangler (the Cloudflare CLI)

Open Terminal and run:

```sh
npm install -g wrangler
wrangler login
```

A browser window will open — sign in to your Cloudflare account.

### 4.3 Create the worker project

```sh
mkdir pearson-bot-license
cd pearson-bot-license
```

Create a file called `wrangler.toml`:

```toml
name = "pearson-bot-license"
main = "worker.js"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "LICENSES"
id = "REPLACE_AFTER_CREATING_KV"
```

Create the KV namespace:

```sh
wrangler kv:namespace create LICENSES
```

It'll print an `id` — copy it and replace `REPLACE_AFTER_CREATING_KV` in `wrangler.toml`.

Create `worker.js` with this code:

```js
// Pearson Review Helper — license validation worker
// Deploy with: wrangler deploy

const ALLOWED_ORIGINS = [
  "chrome-extension://", // accepts any chrome-extension://... origin
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(req.url);
    if (url.pathname !== "/validate") {
      return json({ error: "Not found" }, 404);
    }
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Bad JSON" }, 400);
    }

    const { license, deviceId } = body || {};
    if (!license || !deviceId) {
      return json({ error: "Missing license or deviceId" }, 400);
    }

    const raw = await env.LICENSES.get(license, { type: "json" });
    if (!raw) {
      return json({ valid: false, error: "Invalid license key" }, 200);
    }

    // Schema:
    // {
    //   plan: "Standard",
    //   monthlyCap: 1000,
    //   validUntil: 1740000000000,  // ms epoch
    //   maxDevices: 2,
    //   devices: ["d_abc...", "d_xyz..."],
    //   notes: "alex@email.com - paid 2025-04-01"
    // }

    if (raw.validUntil && raw.validUntil < Date.now()) {
      return json({ valid: false, error: "License expired" }, 200);
    }

    raw.devices = raw.devices || [];
    if (!raw.devices.includes(deviceId)) {
      if (raw.devices.length >= (raw.maxDevices || 2)) {
        return json(
          {
            valid: false,
            error: `Device limit reached (${raw.maxDevices || 2}). Contact support to reset.`,
          },
          200
        );
      }
      raw.devices.push(deviceId);
      await env.LICENSES.put(license, JSON.stringify(raw));
    }

    return json({
      valid: true,
      plan: raw.plan || "Standard",
      monthlyCap: raw.monthlyCap || 1000,
      validUntil: raw.validUntil || Date.now() + 30 * 86400000,
    });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
```

Deploy:

```sh
wrangler deploy
```

Wrangler will print your worker URL, something like `https://pearson-bot-license.your-subdomain.workers.dev`.

### 4.4 Wire the worker URL into the extension

Open `extension/background.js` and find this line:

```js
const LICENSE_SERVER = "https://pearson-bot-license.YOUR-SUBDOMAIN.workers.dev";
```

Replace `YOUR-SUBDOMAIN` with whatever Wrangler printed. Save.

### 4.5 Issue your first license key

To create a license, you write a JSON object to your KV store with the license key as the key. Use the Cloudflare dashboard:

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **KV** → **LICENSES**
2. Click **Add entry**
3. **Key:** something memorable like `PRH-A7K9-MN3B-2X4P` (anything works, but keep it hard to guess)
4. **Value:** paste this JSON (edit fields for the customer):

```json
{
  "plan": "Standard",
  "monthlyCap": 1000,
  "validUntil": 1748131200000,
  "maxDevices": 2,
  "notes": "alex@gmail.com - paid 2025-04-01 via Venmo"
}
```

`validUntil` is a millisecond UNIX timestamp. Get one from https://www.epochconverter.com/ — for "30 days from today" pick today + 30 days at midnight.

5. Click **Save**

The license is now active. Email it to the customer.

### 4.6 Revoking a license

To kill a customer's license (refund, abuse, missed payment):

- **Option A — soft revoke:** Set `validUntil` to a past timestamp. They'll be locked out within 24h (the extension re-checks daily).
- **Option B — hard delete:** Delete the KV entry. They'll be locked out within 24h.
- **Option C — instant:** Same as A or B, but ask the customer to also click Activate again — that forces an immediate server check.

### 4.7 Renewing a monthly subscription

When a customer pays their next month:
1. Open the KV entry
2. Update `validUntil` to the new expiry (today + 30 days)
3. Save

That's the entire renewal flow. No webhook, no Stripe, just edit a JSON value.

---

## 5. Day-to-day operations

### Tracking customers (use a Google Sheet)

Make a sheet with columns:
- Customer email / handle
- License key
- Plan
- Paid date
- Next renewal date
- Payment method
- Notes / refund history

Fill it in by hand for now. When you hit ~20 customers, automate it.

### Handling support tickets

Common issues:

| Symptom | Cause | Fix |
|---|---|---|
| "License expired or unverified" in popup | Their `validUntil` passed | Renew in KV |
| "Device limit reached" | They installed on a 3rd machine | Bump `maxDevices` or clear `devices` array in KV |
| "Cannot reach license server" | Worker is down OR they're offline | Check Worker dashboard for errors; if Worker is fine, it's their internet |
| "Monthly cap reached" | They burned through their tier | Sell them an upgrade, or wait for the 1st of the month |
| "OpenAI 429 insufficient_quota" | Their OpenAI account is out of credit | Tell them to top up at platform.openai.com/billing |
| "no question element found" | New Pearson widget type | Update the bot |

### Updating the bot

When Pearson breaks something or you add a new widget type:
1. Edit the relevant file in `extension/`
2. Bump `version` in `manifest.json` (e.g. `0.1.0` → `0.1.1`)
3. Re-zip and email the new `extension/` folder to all customers
4. Customers reload the extension at `chrome://extensions`

In the future you should publish to the Chrome Web Store so updates are automatic — but it costs $5, requires a developer account, and the Web Store **will reject this extension** if they figure out what it does. So for now: manual updates.

---

## 6. Customer install instructions (give this to every customer)

> **Welcome to Pearson Review Helper.**
>
> ### Step 1 — Install the extension
> 1. Download the `extension` folder I sent you. Unzip it.
> 2. Open Chrome and go to `chrome://extensions`
> 3. Turn on **Developer mode** (top-right toggle)
> 4. Click **Load unpacked** and select the unzipped `extension` folder
> 5. Pin the **Pearson Review Helper** icon to your toolbar (puzzle-piece icon → push pin next to its name)
>
> ### Step 2 — Get an OpenAI API key
> 1. Go to https://platform.openai.com/api-keys
> 2. Sign in (or sign up) and click **Create new secret key**
> 3. Copy the key (starts with `sk-`)
> 4. Go to https://platform.openai.com/settings/organization/billing/overview and add **$5 to your credit balance** (you'll use ~$1-3/month)
>
> ### Step 3 — Activate
> 1. Click the Pearson Review Helper icon in your toolbar
> 2. Paste your license key (the one I sent you) and click **Activate**
> 3. Paste your OpenAI API key
> 4. Choose a model: **gpt-4o** is the recommended balance of cost and accuracy
> 5. Click **Save settings**
>
> ### Step 4 — Use it
> Open a Pearson MyLab assignment, navigate to the first question, click the extension icon, and click **Start Auto Mode**. The bot will solve every question and stop when the assignment ends.
>
> If you want to verify each answer manually instead, click **Solve** (selects but doesn't submit) or **Solve + Next** (solves, submits, advances) one question at a time.
>
> ### Troubleshooting
> - **Bot not detecting the question:** Refresh the page. If still broken, message me with a screenshot.
> - **Wrong answers:** Switch the model to `gpt-4.1` for better accuracy.
> - **"License expired":** Send me the renewal payment.
> - **"Cannot reach license server":** Check your internet, then click Activate again.
>
> **Important:** This tool uses the OpenAI API directly with YOUR key. Your usage costs go to OpenAI, not me. Subscription pays for the bot itself, not the AI calls.

---

## 7. Legal / risk notes (read before launch)

This section is for you, not customers.

- Pearson's Terms of Service almost certainly prohibit automated interaction with their service. Selling a tool that does this is a different legal posture than building it for personal use.
- Real-world precedent: Course Hero, Chegg, and similar services have been sued by publishers. Most settle.
- Mitigations to consider:
  1. **Require an explicit acceptance-of-risk checkbox** in the popup before first use. Wording like "I confirm this assignment permits automation tools."
  2. **No marketing on TikTok/Instagram with screenshots of Pearson branding.** Use a generic name like "Study Assistant for [discipline]."
  3. **Don't put the seller's real name on the landing page** — use a brand only.
  4. **LLC for liability separation.** Stripe Atlas, $500, takes ~1 week. Do this before you have 20+ paying customers.
  5. **No bank account in your personal name receiving payments.** Once you LLC up, route everything through a business bank account.
- This guide is operational, not legal advice. Talk to a lawyer before you scale past a handful of friends.

---

## 8. Roadmap — what to build next

Rough order of value:

1. **Acceptance checkbox** in the popup, gates first run on user agreeing
2. **Telemetry endpoint** — every solve sends `{license, model, kind, success}` to a second worker that logs to KV. Lets you see usage patterns and find power users.
3. **Per-license usage cap on the server side** so users can't tamper with `monthlyCap` in storage
4. **License auto-issuance** — a Stripe webhook that creates the KV entry when payment lands. Eliminates manual onboarding.
5. **Auto-update mechanism** — a `version.json` file on a CDN that the extension checks on startup; if newer, prompts user to update
6. **More widget types:**
   - Numeric input (math/physics/chem)
   - Free-text fill-in
   - Dropdown fill-in
   - Equation editor (hardest)
   - Graphing widgets (probably skip)
7. **Self-hosted dashboard** for license management instead of editing KV by hand
8. **Multi-model agreement** for accuracy boost (send to gpt-4o + gpt-4.1, only commit if they agree)

---

## 9. File reference

- `extension/manifest.json` — Chrome extension manifest
- `extension/background.js` — Service worker; OpenAI calls, license check, page injection
- `extension/popup.html` / `popup.js` — Popup UI
- `worker.js` (Cloudflare) — License validation server
- `wrangler.toml` (Cloudflare) — Worker config
- `SETUP.md` (this file) — Operations doc
