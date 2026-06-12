# Scratchpad → TCI Sim patient sync — sender spec

This document is the contract for the **scratchpad app** (the sender). TCI Sim
implements the receiving side; the scratchpad implements the pushing side
described here. Both apps live on Vercel but run on different devices, so the
handoff goes through a small cloud "scratch area" (a Vercel serverless endpoint
backed by Upstash Redis) keyed by a shared pairing code.

> **De-identified / training use only.** Only age, sex, height, and weight
> transfer. Do **not** push protected health information (names, MRNs, dates,
> etc.) through this channel. The endpoint is unauthenticated — the pairing code
> is the only secret — and entries auto-expire after 30 minutes.

> **Note:** the same endpoint also serves `kind=case|template` payloads for
> TCI Sim's own device-to-device transfer (see `DEPLOY.md`). The scratchpad
> contract below is the no-`kind` default and is unaffected.

---

## 1. Pairing code

- Format: `^[A-HJ-NP-Z2-9]{6}$` — 6 uppercase alphanumerics, **excluding the
  ambiguous characters `0 O 1 I`**.
- Normalization (apply on both sides before use): strip all whitespace,
  uppercase.
- **The scratchpad generates and displays the code.** TCI Sim asks the user to
  type it into **Settings → Sync**. Generate it once and keep it stable (persist
  in the scratchpad's `localStorage`); regenerating it un-pairs the apps.

Suggested generator:

```js
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function generatePairingCode() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, b => ALPHABET[b % ALPHABET.length]).join('');
}
```

---

## 2. Endpoint & payload

**Base URL:** `https://<tcisim-host>/api/sync` (the TCI Sim deployment that owns
the serverless function — substitute the real host).

### Write (the scratchpad's job)

```
POST https://<tcisim-host>/api/sync
Content-Type: application/json

{
  "code": "ABC234",
  "patient": {
    "age": 45,            // integer 1..120
    "sex": "male",        // "male" | "female"
    "heightCm": 180,      // number 30..250  (CANONICAL METRIC)
    "weightKg": 80        // number 0.5..300 (CANONICAL METRIC)
  }
}
```

- **Send canonical metric.** The scratchpad does imperial→metric *before*
  pushing: `cm = inches * 2.54`, `kg = lbs * 0.453592`. TCI Sim re-displays in
  whatever units its user has selected.
- **Do not send `opioid` or any other field** — extra fields are rejected by the
  validator. Opioid co-administration is set independently in TCI Sim.
- Do **not** send a timestamp; the server sets `updatedAt` itself.

**Response `200`:** `{ "ok": true, "updatedAt": 1717340000000 }` (server epoch ms).
**Errors:** `400` invalid code / bad JSON / invalid patient (out of range),
`413` body > 1 KB, `405` wrong method, `500` server/KV error.

### Read (TCI Sim's job — for reference)

```
GET https://<tcisim-host>/api/sync?code=ABC234
→ 200 { "found": true, "patient": { age, sex, heightCm, weightKg, updatedAt } }
→ 200 { "found": false }     // nothing stored yet, or expired
```

---

## 3. CORS

The scratchpad is a different origin, and a JSON `POST` triggers a CORS
**preflight** (`OPTIONS`). The server handles `OPTIONS` and echoes an
allow-listed origin — but **the scratchpad's origin must be added to the
serverless `SYNC_ALLOWED_ORIGINS` env var** (comma-separated) on the TCI Sim
deployment, or the browser will block the request. Coordinate this when wiring
the two deployments.

---

## 4. TTL / freshness

- Entries expire **30 minutes** after the last write; each `POST` refreshes the
  window.
- TCI Sim pulls **on demand** (a button), not automatically, and shows the
  `updatedAt` as "updated N min ago" so the user can confirm the data is current.
- Because TCI Sim only reads when asked, the scratchpad should keep the entry
  fresh while the user is actively editing (the debounced auto-push below does
  this naturally).

---

## 5. Drop-in auto-push (no Send button)

Push transparently on every demographics change, debounced. No-ops when the code
is invalid or fields are incomplete; swallows offline errors (the next change
re-pushes).

```js
const ENDPOINT = 'https://<tcisim-host>/api/sync';
let _t = null;

/**
 * @param {() => string} getCode             returns the (normalized) pairing code
 * @param {() => object|null} getPatientMetric returns { age, sex, heightCm, weightKg } or null if incomplete/invalid
 * @param {number} delay                      debounce ms
 */
export function scheduleSync(getCode, getPatientMetric, delay = 800) {
  clearTimeout(_t);
  _t = setTimeout(async () => {
    const code = (getCode() || '').replace(/\s+/g, '').toUpperCase();
    const patient = getPatientMetric();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code) || !patient) return;
    try {
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, patient }),
        keepalive: true, // lets the push complete if the app is backgrounded
      });
    } catch (_) {
      /* offline or blocked — next field change will retry */
    }
  }, delay);
}

// Call scheduleSync(...) from every age/sex/height/weight input handler.
```

`getPatientMetric()` should return `null` until all four fields are valid and in
range, and otherwise return the canonical-metric object — that keeps partial
entries out of the scratch area.
