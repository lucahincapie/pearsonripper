# Coursepilot — Operator Setup

The unified Coursepilot extension covers both McGraw Hill Recharge and Pearson MyLab.
This doc is for **you** (the operator) — what to do to host the licensing backend and
ship the product. Customers don't see any of this.

---

## File layout

```
coursepilot/
├── extension/
│   ├── manifest.json         # MV3 manifest, both host permissions
│   ├── background.js         # Service worker — license, message router, badge
│   ├── pearson-handlers.js   # Pearson logic (loaded via importScripts)
│   ├── mh-content.js         # McGraw content script (isolated world)
│   ├── mh-injected.js        # McGraw main-world hook + hidata decoder
│   ├── popup.html / popup.js # Unified popup, detects active platform
│   ├── onboarding.html       # First-run welcome page
└── SETUP.md                  # this file
```

---

## 1. Deploy the Cloudflare Worker (license server)

Same flow as before — Cloudflare Workers free tier, KV-backed, ~10 minutes to set up.

1. Create a new Worker named `coursepilot-license` at dash.cloudflare.com
2. Paste in the worker code (below). Click **Deploy**.
3. Create a KV namespace named `LICENSES`. Bind it to the worker as `LICENSES`.
4. In `extension/background.js`, replace `LICENSE_SERVER` with your worker URL.
5. Rotate `MASTER_LICENSE` from `COURSEPILOT-DEV-FOREVER` to a private value before
   you publish anywhere. Your dev machine keeps using it.

### Worker code

```js
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== "/validate") {
      return new Response("Not found", { status: 404, headers: cors });
    }
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const { license, deviceId } = body;
    if (!license || !deviceId) {
      return json({ valid: false, error: "Missing license or deviceId" }, 400, cors);
    }
    const raw = await env.LICENSES.get(license);
    if (!raw) return json({ valid: false, error: "Unknown license" }, 200, cors);
    let rec;
    try { rec = JSON.parse(raw); } catch { return json({ valid: false, error: "Corrupt record" }, 200, cors); }
    if (rec.expiresAt && rec.expiresAt < Date.now()) {
      return json({ valid: false, error: "License expired" }, 200, cors);
    }
    rec.devices = rec.devices || [];
    if (!rec.devices.includes(deviceId)) {
      const max = rec.maxDevices || 2;
      if (rec.devices.length >= max) {
        return json({ valid: false, error: `License already used on ${max} devices` }, 200, cors);
      }
      rec.devices.push(deviceId);
      await env.LICENSES.put(license, JSON.stringify(rec));
    }
    return json({
      valid: true,
      plan: rec.plan || "Active",
      monthlyCap: rec.monthlyCap || 1000,
      validUntil: rec.expiresAt || Date.now() + 30 * 86400000,
    }, 200, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
```

### Issuing a license manually

In the Cloudflare KV UI, add an entry to the `LICENSES` namespace:

- **Key:** `COURSEPILOT-ABCD-EFGH-IJKL` (any string — give the customer this)
- **Value:** `{ "plan": "Standard", "expiresAt": 1788000000000, "maxDevices": 2 }`

`expiresAt` is a JS millisecond timestamp. Run `Date.now() + 30 * 86400000` in DevTools
for a 30-day expiry from now.

---

## 2. Pricing

**One tier, both platforms.**

| Tier | Price | Devices | What they get |
|---|---|---|---|
| **Coursepilot Pro** | $14.99/mo | 2 | Both platforms, all features |

Cleanest funnel. Add a $24.99 "5-device" tier later if customers ask.

---

## 3. The "moat" pitch (sales page copy)

Headline: **"100% accuracy on Recharge. AI-powered on MyLab. One extension."**

- ✅ Recharge: reads McGraw's own answer data — never wrong, $0 per question
- ✅ MyLab: BYO OpenAI key — full answer extraction, ~95% accuracy
- ✅ Live accuracy stats, recent activity feed
- ✅ Humanlike timing — no instant click patterns
- ✅ Auto-recover when Recharge stalls
- ✅ Onboarding included — no setup gymnastics

The Recharge accuracy claim is your moat. Every other study bot is GPT-based, costs
money per question, and gets ~92%. You hit 100% on Recharge for $0/question. Lead
with that everywhere.

---

## 4. Distribution

### Option A: Chrome Web Store unlisted (recommended)

- $5 dev fee. Submit as **unlisted** so customers install via direct link.
- 1–3 day review. Use neutral copy: "study aid that displays answer rationales"
- Pros: auto-update, legitimacy, easy install
- Cons: review risk if Google decides academic-integrity is a problem

### Option B: Direct ZIP via Gumroad

- Zip the `extension/` folder, sell on Gumroad/Lemon Squeezy
- Customer extracts → `chrome://extensions` → Developer Mode → Load Unpacked
- No review, total control over messaging
- Cons: harder install, no auto-update — you have to email customers each release

**Recommendation:** Try A first. If rejected, fall back to B.

---

## 5. Things to do before public launch

- [ ] Deploy the Cloudflare worker, replace `LICENSE_SERVER` URL
- [ ] Rotate `MASTER_LICENSE` to a private value (keep one copy for your own use)
- [ ] Test full activation flow on both Recharge and MyLab tabs
- [ ] Decide distribution path (Web Store vs ZIP)
- [ ] Set up Gumroad/Lemon Squeezy or Stripe checkout
- [ ] Build the landing page (use the headline + bullets above)
- [ ] Build a "report a broken question" button in the popup that POSTs to the worker
- [ ] Build silent telemetry: when ingest fails for 5+ Q in a row, ping your worker
      so you hear about breakage before customers do — biggest churn-saver

---

## 6. Things NOT to do

- Don't put "cheating" anywhere in marketing copy. Use "study aid" / "review tool"
- Don't ship the master key publicly
- Don't promise undetectability in writing
- Don't accept refund requests for "I got caught" — your TOS should say the user
  assumes all academic risk
- Don't build a free tier — doubles support load, doesn't convert. 7-day refund instead.

---

## 7. Known limitations (v0.1)

- **Recharge re-asked questions stall.** When McGraw re-shows a question from
  in-memory state instead of refetching, the bot stalls and auto-reloads after 8s.
  Mostly works around it but it's a 5-second pause every ~10 questions.
- **Pearson uses BYOK.** You eat zero API cost but customers have to paste their
  own OpenAI key. The popup shows a clear field for it.
- **Pearson stats and Recharge stats are stored in different keys** (legacy from
  the merge). The popup sums them both, but resetting one doesn't reset the other.
- **No telemetry yet.** When McGraw or Pearson breaks, you find out from a support
  ticket, not a beacon. Build telemetry before scaling past ~20 customers.
