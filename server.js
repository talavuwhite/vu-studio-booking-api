/**
 * VU Studio Booking API
 * - Pricing/quote + Stripe Checkout (promo/coupons entered on Stripe page)
 *
 * ENV you should set on Render:
 *   STRIPE_SECRET_KEY            (or STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY_LIVE)
 *   SUCCESS_URL                  (e.g. https://vizionzunlimited.com/bookingsuccess)
 *   CANCEL_URL                   (e.g. https://vizionzunlimited.com/bookingcancel)
 * Optional:
 *   CORS_ORIGIN                  (frontend origin, e.g. https://vizionzunlimited.com or *)
 *   PORT                         (Render injects 10000 automatically)
 */

import express from "express";
import cors from "cors";
import Stripe from "stripe";

// ---------- Env & Stripe ----------
const stripeSecret =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  null;

const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: "2024-06-20" })
  : null;

const SUCCESS_URL = process.env.SUCCESS_URL || "";
const CANCEL_URL = process.env.CANCEL_URL || "";

const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
  })
);

// ---------- Utilities / Pricing ----------

// Hourly rates
const RATES = {
  AUDIO_ONLY: 45, // $/hr
  ONE_CAMERA: 55, // $/hr
  ENGINEER_PER_HOUR: 20, // $/hr
};

// Per-session add-ons (flat)
const ADDONS = {
  EXTRA_CAMERA_EACH: 25, // per extra camera (flat per session)
  REMOTE_GUEST: 10,
  TELEPROMPTER: 25,
  AD_CLIPS_5: 150,
  MEDIA_SD_OR_USB: 50,
};

// Post-production tier (flat per session) by number of cams to edit (0-4)
const POST_TIER = {
  0: 0,
  1: 200,
  2: 250,
  3: 300,
  4: 350,
};

// Compute totals according to business rules
function computeTotals(body = {}) {
  // Normalize
  const b = body || {};
  const isFirst = !!b.isFirstTime;

  // Hours guardrails:
  // - Overall min 1 hr, but if first-time then min 2 hrs.
  let hours = Number(b.hours) || 0;
  if (isFirst && hours < 2) hours = 2;
  if (!isFirst && hours < 1) hours = 1;

  // Mode
  const mode = String(b.mode || "ONE_CAMERA").toUpperCase(); // AUDIO_ONLY or ONE_CAMERA
  const baseRate = mode === "AUDIO_ONLY" ? RATES.AUDIO_ONLY : RATES.ONE_CAMERA;

  // Base included cameras: AUDIO_ONLY = 0; ONE_CAMERA = 1
  const baseIncludedCams = mode === "AUDIO_ONLY" ? 0 : 1;

  // People on camera affects total camera count only (no price change),
  // but we'll use the resulting total when computing post-production default.
  const peopleOnCamera = Math.max(0, Number(b.peopleOnCamera) || 0);

  // Extra cameras are optional paid add-ons (flat per session)
  const extraCameras = Math.max(0, Number(b.extraCameras) || 0);

  // Total cams = max(base + extras, people on camera)
  const totalCams = Math.max(baseIncludedCams + extraCameras, peopleOnCamera);

  // Engineer choice: 'any' | 'specific' | 'none'
  const engineerChoice = String(b.engineerChoice || "any").toLowerCase();
  const wantsEngineer = engineerChoice !== "none";

  // Subtotals
  const baseSubtotal = baseRate * hours;
  const engineerSubtotal = wantsEngineer ? RATES.ENGINEER_PER_HOUR * hours : 0;

  // Per-session add-ons (flat)
  let extrasSession = 0;
  if (extraCameras > 0)
    extrasSession += extraCameras * ADDONS.EXTRA_CAMERA_EACH;
  if (b.remoteGuest) extrasSession += ADDONS.REMOTE_GUEST;
  if (b.teleprompter) extrasSession += ADDONS.TELEPROMPTER;
  if (b.adClips5) extrasSession += ADDONS.AD_CLIPS_5;
  if (b.mediaSdOrUsb) extrasSession += ADDONS.MEDIA_SD_OR_USB;

  // Post-production
  // If client selected `postProduction` as number of cams to edit, use that.
  // Otherwise, default to totalCams (max 4).
  let camsForPost = 0;
  if (b.postProduction === "" || b.postProduction === null || b.postProduction === undefined) {
    camsForPost = 0;
  } else {
    camsForPost = Math.min(4, Math.max(0, Number(b.postProduction) || 0));
  }
  // Guard: 0 cams means $0 (this fixes the "None still charges $200" bug)
  const postProd = POST_TIER[camsForPost] ?? 0;

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

  return {
    totals: {
      baseSubtotal,
      engineerSubtotal,
      extrasSession,
      postProd,
    },
    total,
    totalCams,
    hours,
    mode,
    wantsEngineer,
    extraCameras,
    camsForPost,
    baseRate,
  };
}

// ---------- Routes ----------

// Quick status check for Render
app.get("/env-check", (req, res) => {
  const hasLive = !!process.env.STRIPE_SECRET_KEY_LIVE;
  const hasTest =
    !!process.env.STRIPE_SECRET_KEY || !!process.env.STRIPE_SECRET_KEY_TEST;

  const mode =
    hasLive ? "live" : hasTest ? "test" : "none";

  res.json({
    mode,
    hasKey: !!stripeSecret,
    keyLength: stripeSecret ? stripeSecret.length : 0,
    port: String(PORT),
  });
});

// Compute price quote (no Stripe call)
app.post("/quote", (req, res) => {
  try {
    const result = computeTotals(req.body || {});
    return res.json({
      ...result,
      breakdown: result.totals,
    });
  } catch (err) {
    console.error("QUOTE ERROR:", err);
    return res.status(400).json({ error: "Invalid request" });
  }
});

// Stripe Checkout (promo code is entered by the customer on the Stripe page)
app.post("/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured." });
    }
    if (!SUCCESS_URL || !CANCEL_URL) {
      return res
        .status(500)
        .json({ error: "SUCCESS_URL/CANCEL_URL are not set on the server." });
    }

    const b = req.body || {};
    const {
      totals,
      totalCams,
      hours,
      mode,
      wantsEngineer,
      extraCameras,
      camsForPost,
      baseRate,
    } = computeTotals(b);

    const customer = b.customer || {};
    const room = String(b.room || "The Studio");

    // Build line items
    const line_items = [];

    // Base booking (hourly)
    line_items.push({
      price_data: {
        currency: "usd",
        product_data: {
          name:
            mode === "AUDIO_ONLY"
              ? "Studio booking (AUDIO ONLY)"
              : "Studio booking (ONE CAMERA)",
        },
        unit_amount: Math.round(baseRate * 100), // cents
      },
      quantity: Math.max(1, hours),
    });

    // Engineer (hourly)
    if (wantsEngineer) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Studio Engineer" },
          unit_amount: Math.round(RATES.ENGINEER_PER_HOUR * 100),
        },
        quantity: Math.max(1, hours),
      });
    }

    // Per-session add-ons (flat)
    if (extraCameras > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: `Extra cameras (${extraCameras})` },
          unit_amount: Math.round(ADDONS.EXTRA_CAMERA_EACH * extraCameras * 100),
        },
        quantity: 1,
      });
    }
    if (b.remoteGuest) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Remote Guest" },
          unit_amount: ADDONS.REMOTE_GUEST * 100,
        },
        quantity: 1,
      });
    }
    if (b.teleprompter) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Teleprompter" },
          unit_amount: ADDONS.TELEPROMPTER * 100,
        },
        quantity: 1,
      });
    }
    if (b.adClips5) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "5 Ad Clips" },
          unit_amount: ADDONS.AD_CLIPS_5 * 100,
        },
        quantity: 1,
      });
    }
    if (b.mediaSdOrUsb) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Media to SD/USB" },
          unit_amount: ADDONS.MEDIA_SD_OR_USB * 100,
        },
        quantity: 1,
      });
    }

    // Post-production (flat; 0 cams => $0, so skip when 0)
    if (camsForPost > 0) {
      line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: `Post Production (${camsForPost} cam${camsForPost > 1 ? "s" : ""})` },
          unit_amount: POST_TIER[camsForPost] * 100,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true, // lets customer enter coupon on Stripe page
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      line_items,
      metadata: {
        room,
        date: String(b.date || ""),
        startTime: String(b.startTime || ""),
        hours: String(hours),
        mode,
        totalCams: String(totalCams),
        engineer: wantsEngineer ? "yes" : "no",
        extraCameras: String(extraCameras),
        postProductionCams: String(camsForPost),
        customer_name: String(customer.name || ""),
        customer_email: String(customer.email || ""),
        customer_phone: String(customer.phone || ""),
        notes: String(b.notes || ""),
      },
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    return res.status(400).json({ error: "Checkout failed.", details: String(err.message || err) });
  }
});

// Root
app.get("/", (req, res) => {
  res.type("text").send("VU Studio Booking API is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(`VU Studio Booking API listening on :${PORT}`);
});
