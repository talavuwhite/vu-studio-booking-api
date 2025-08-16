// server.js — VU Studio Booking API (fixed post-production $0 for None)

import express from "express";
import cors from "cors";
import "dotenv/config";
import StripePkg from "stripe";

const app = express();

// ---- CORS ----
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    credentials: false,
  })
);
app.use(express.json());

// ---- Stripe init (auto-pick secret) ----
const stripeSecret =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  "";
const stripe =
  stripeSecret ? new StripePkg.Stripe(stripeSecret, { apiVersion: "2024-06-20" }) : null;

// ---- URLs ----
const SUCCESS_URL = process.env.SUCCESS_URL || "";
const CANCEL_URL = process.env.CANCEL_URL || "";

// ---- Helpers: Pricing Rules ----
const HOURLY_AUDIO = 45; // $/hr
const HOURLY_ONE_CAM = 55; // $/hr (min 2 hours overall)
const HOURLY_ENGINEER = 20; // $/hr

const EXTRA_CAMERA_SESSION = 25; // $/session
const REMOTE_GUEST_SESSION = 10; // $/session
const TELEPROMPTER_SESSION = 25; // $/session
const AD_CLIPS_5_SESSION = 150; // $/session
const MEDIA_SD_USB_SESSION = 50; // $/session

// Post-production flat tier (0 is FREE)
const POST_TIER = { 0: 0, 1: 200, 2: 250, 3: 300, 4: 350 };

// Normalize booleans safely
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "1", "yes", "on"].includes(v.toLowerCase());
  return !!v;
}

// Main calculator (single source of truth)
function computeTotals(body) {
  const b = body || {};

  const hours = Math.max(2, Number(b.hours || 2));

  // Base rate: Audio vs One Cam
  const mode = (b.mode || "ONE_CAMERA").toUpperCase();
  const baseRate = mode === "AUDIO_ONLY" ? HOURLY_AUDIO : HOURLY_ONE_CAM;
  const baseSubtotal = baseRate * hours;

  // Engineer
  const engineerChoice = (b.engineerChoice || "any").toLowerCase(); // any|none|name
  const wantsEngineer = engineerChoice !== "none";
  const engineerSubtotal = wantsEngineer ? HOURLY_ENGINEER * hours : 0;

  // Session add-ons
  const extraCameras = Math.max(0, Number(b.extraCameras || 0));
  let extrasSession = 0;
  if (extraCameras > 0) extrasSession += extraCameras * EXTRA_CAMERA_SESSION;
  if (toBool(b.remoteGuest)) extrasSession += REMOTE_GUEST_SESSION;
  if (toBool(b.teleprompter)) extrasSession += TELEPROMPTER_SESSION;
  if (toBool(b.adClips5)) extrasSession += AD_CLIPS_5_SESSION;
  if (toBool(b.mediaSdOrUsb)) extrasSession += MEDIA_SD_USB_SESSION;

  // Cameras count for display (does NOT set price by itself)
  const baseIncludedCams = mode === "AUDIO_ONLY" ? 0 : 1;
  const peopleOnCamera = Math.max(1, Number(b.peopleOnCamera || 1));
  const totalCams = baseIncludedCams + extraCameras + Math.max(0, peopleOnCamera - 1);

  // ---- FIX: Post Production (0 -> $0, no fallback) ----
  const camsForPost = Math.max(0, Number(b.postProduction || 0)); // strictly what user selected
  const postProd = POST_TIER[camsForPost] ?? 0;

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

  return {
    breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd },
    total,
    totalCams,
  };
}

// ---- Health & Diagnostics ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/env-check", (_req, res) => {
  const mode = stripeSecret.startsWith("sk_live_")
    ? "live"
    : stripeSecret.startsWith("sk_test_")
    ? "test"
    : "none";

  res.json({
    mode,
    hasKey: !!stripeSecret,
    hasStripe: !!stripe,
    successUrlSet: !!SUCCESS_URL,
    cancelUrlSet: !!CANCEL_URL,
    port: String(process.env.PORT || 5000),
  });
});

// ---- Quote ----
app.post("/quote", (req, res) => {
  try {
    const result = computeTotals(req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Failed to compute quote" });
  }
});

// ---- Checkout (Stripe) ----
app.post("/checkout", async (req, res) => {
  try {
    if (!stripe || !stripeSecret) {
      return res.status(500).json({ error: "Stripe not configured" });
    }
    if (!SUCCESS_URL || !CANCEL_URL) {
      return res.status(500).json({ error: "Missing SUCCESS_URL or CANCEL_URL" });
    }

    const payload = req.body || {};
    const { total } = computeTotals(payload);

    // Basic guards
    const c = payload.customer || {};
    if (!c.name || !c.email || !payload.date || !payload.startTime) {
      return res.status(400).json({ error: "Missing required fields (name, email, date, startTime)" });
    }

    // Create a single line item representing the session
    const sessionTitle = `Studio Booking — ${payload.room || "Room"} — ${payload.date} @ ${payload.startTime}`;
    const description = [
      `Mode: ${payload.mode || "ONE_CAMERA"}`,
      `Hours: ${payload.hours || 2}`,
      `Engineer: ${payload.engineerChoice || "any"}`,
      `People on Camera: ${payload.peopleOnCamera || 1}`,
      `Extras: extCams=${payload.extraCameras || 0}, remote=${toBool(payload.remoteGuest) ? "Y" : "N"},` +
        ` tele=${toBool(payload.teleprompter) ? "Y" : "N"}, clips=${toBool(payload.adClips5) ? "Y" : "N"}, media=${toBool(payload.mediaSdOrUsb) ? "Y" : "N"}`,
      `Post: ${Number(payload.postProduction || 0)} cams`,
    ].join(" | ");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      allow_promotion_codes: true, // coupons handled on Stripe page
      customer_email: c.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(Number(total || 0) * 100), // cents
            product_data: {
              name: sessionTitle,
              description,
            },
          },
        },
      ],
      metadata: {
        customer_name: c.name,
        customer_phone: c.phone || "",
        room: payload.room || "",
        date: payload.date || "",
        startTime: payload.startTime || "",
        hours: String(payload.hours || 2),
        mode: payload.mode || "",
        engineerChoice: payload.engineerChoice || "",
        peopleOnCamera: String(payload.peopleOnCamera || 1),
        extraCameras: String(payload.extraCameras || 0),
        remoteGuest: toBool(payload.remoteGuest) ? "true" : "false",
        teleprompter: toBool(payload.teleprompter) ? "true" : "false",
        adClips5: toBool(payload.adClips5) ? "true" : "false",
        mediaSdOrUsb: toBool(payload.mediaSdOrUsb) ? "true" : "false",
        postProduction: String(payload.postProduction || 0),
        notes: payload.notes || "",
      },
    });

    return res.json({ checkoutUrl: session.url });
  } catch (e) {
    console.error("Checkout error:", e);
    return res.status(500).json({ error: e?.message || "Checkout failed" });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 5000; // Render injects 10000
app.listen(PORT, () => {
  console.log(`VU Booking API listening on ${PORT}`);
});
