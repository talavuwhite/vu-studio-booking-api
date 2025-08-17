// server.js — VU Studio Booking API (ESM)
// Uses Stripe Checkout, returns sessionId + checkoutUrl,
// and guarantees postProduction=0 costs $0.

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

// ---- env & basics -----------------------------------------------------------
const app = express();
app.use(express.json());

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin,
  })
);

const stripeSecret =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  null;

const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' })
  : null;

const SUCCESS_URL =
  process.env.SUCCESS_URL || 'https://vizionzunlimited.com/bookingsuccess';
const CANCEL_URL =
  process.env.CANCEL_URL || 'https://vizionzunlimited.com/bookingcancel';

const PORT = process.env.PORT || 10000;

// ---- helpers ---------------------------------------------------------------
function envModeFromKey(key) {
  if (!key) return 'none';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

function num(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

// Pricing rules
const HOURLY_BASE_ONE_CAM = 55;  // $55/hr
const HOURLY_ENGINEER = 20;      // $20/hr
const TELEPROMPTER_FEE = 25;     // per session
const REMOTE_GUEST_FEE = 10;
const AD_CLIPS_5_FEE = 150;
const MEDIA_SD_USB_FEE = 50;
const POST_PROD_PER_CAM = 200;   // $100 per camera to edit
const MIN_HOURS = 2;

/**
 * Calculate totals & breakdown.
 * Enforces: min 2 hours; postProduction=0 => $0 (no charge).
 * People on camera may influence camera count (not price).
 */
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, num(body.hours, 2));
  const mode = body.mode || 'ONE_CAMERA';

  // Base subtotal (pricing currently the same regardless of peopleOnCamera)
  const baseHourly = HOURLY_BASE_ONE_CAM;
  const baseSubtotal = hours * baseHourly;

  // Engineer logic — if user chose "none", no engineer charge
  const engineerChoice = (body.engineerChoice || 'any').toLowerCase();
  const engineerHourly = engineerChoice === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // Extras per session
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // Post production — 0 means none => $0
  const postProduction = Math.max(0, num(body.postProduction, 0));
  const postProdSubtotal = postProduction === 0
    ? 0
    : postProduction * POST_PROD_PER_CAM;

  // Cameras used (FYI only; does NOT change price)
  const peopleOnCamera = Math.max(1, num(body.peopleOnCamera, 1));
  const extraCameras = Math.max(0, num(body.extraCameras, 0));
  const totalCams = Math.max(1, peopleOnCamera, 1 + extraCameras);

  const total =
    baseSubtotal + engineerSubtotal + extrasSession + postProdSubtotal;

  return {
    total,
    totalCams,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extrasSession,
      postProd: postProdSubtotal,
    },
    hours,
    mode,
  };
}

// ---- routes ----------------------------------------------------------------

app.get('/env-check', (_req, res) => {
  res.json({
    mode: envModeFromKey(stripeSecret),
    hasKey: !!stripeSecret,
    port: String(PORT),
  });
});

app.post('/quote', (req, res) => {
  try {
    const q = computeQuote(req.body);
    res.json(q);
  } catch (e) {
    res.status(400).json({ error: 'Bad Request', detail: String(e) });
  }
});

// Debug echo
app.post('/quote-debug', (req, res) => {
  const received = req.body || {};
  const totals = computeQuote(received);
  res.json({ received, totals });
});

/**
 * Create Stripe Checkout Session.
 * Returns BOTH checkoutUrl and sessionId (so you can find it in Stripe).
 * Allows promotion codes so customers can enter coupons at checkout.
 */
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const b = req.body || {};
    const q = computeQuote(b);

    const items = [];

    // Base booking
    items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: `Studio booking (${q.mode})` },
        unit_amount: HOURLY_BASE_ONE_CAM * 100,
      },
      quantity: q.hours,
    });

    // Engineer time
    if (q.breakdown.engineerSubtotal > 0) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Studio Engineer' },
          unit_amount: HOURLY_ENGINEER * 100,
        },
        quantity: q.hours,
      });
    }

    // Teleprompter
    if (b.teleprompter) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Teleprompter' },
          unit_amount: TELEPROMPTER_FEE * 100,
        },
        quantity: 1,
      });
    }

    // Post production — only if > 0
    const postProduction = Math.max(0, num(b.postProduction, 0));
    if (postProduction > 0) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Post Production (cams to edit)' },
          unit_amount: POST_PROD_PER_CAM * 100,
        },
        quantity: postProduction,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items,
      allow_promotion_codes: true,
      success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: CANCEL_URL,
    });

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: 'Checkout failed', detail: String(err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
