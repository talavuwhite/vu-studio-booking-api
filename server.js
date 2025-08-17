// server.js — VU Studio Booking API (ESM)
// Pricing rules (must match the front-end):
// - Mode hourly: ONE_CAMERA=$55/hr, AUDIO_ONLY=$45/hr
// - Engineer: $20/hr if engineerChoice !== "none"
// - Extra cameras: $25 each per session (uses numeric extraCameras)
// - Add-ons (flat/session): Teleprompter $25, RemoteGuest $10, AdClips5 $150, Media SD/USB $50
// - Post production (tiered): 0->$0, 1->$200, then +$100 for each additional camera

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// CORS (tighten later to your domain if you want)
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin,
  })
);

// Stripe
const stripeSecret =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  null;

const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' })
  : null;

// Success/Cancel
const SUCCESS_URL =
  process.env.SUCCESS_URL || 'https://vizionzunlimited.com/bookingsuccess';
const CANCEL_URL =
  process.env.CANCEL_URL || 'https://vizionzunlimited.com/bookingcancel';

const PORT = process.env.PORT || 10000;

// ---------- helpers ----------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function envModeFromKey(key) {
  if (!key) return 'none';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

// ---------- PRICING ----------
const HOURLY_ONE_CAMERA = 55; // $/hr
const HOURLY_AUDIO_ONLY = 45; // $/hr
const HOURLY_ENGINEER   = 20; // $/hr if engineer

const EXTRA_CAMERA_FEE  = 25; // $ per extra camera (flat per session)

const TELEPROMPTER_FEE  = 25;
const REMOTE_GUEST_FEE  = 10;
const AD_CLIPS_5_FEE    = 150;
const MEDIA_SD_USB_FEE  = 50;

const MIN_HOURS = 2;

/** post-production tier: 0->$0, 1->$200, 2->$300, 3->$400 ... */
function postProdTiered(cams) {
  const c = Math.max(0, n(cams, 0));
  if (c === 0) return 0;
  return 200 + (c - 1) * 100;
}

/** Compute quote using the rules above */
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, n(body.hours, 2));
  const mode  = (body.mode || 'ONE_CAMERA').toUpperCase();

  // Hourly based on mode
  const baseHourly =
    mode === 'AUDIO_ONLY' ? HOURLY_AUDIO_ONLY : HOURLY_ONE_CAMERA;
  const baseSubtotal = hours * baseHourly;

  // Engineer
  const engChoice = (body.engineerChoice || 'any').toLowerCase();
  const engineerHourly = engChoice === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // Add-ons (flat)
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // Extra cameras (flat × count)
  const extraCameras = Math.max(0, n(body.extraCameras, 0));
  const extraCamsSubtotal = extraCameras * EXTRA_CAMERA_FEE;

  // Post production tier
  const postProduction = Math.max(0, n(body.postProduction, 0));
  const postProdSubtotal = postProdTiered(postProduction);

  // FYI cam count (display only)
  const peopleOnCamera = Math.max(1, n(body.peopleOnCamera, 1));
  const totalCams = Math.max(1, 1 + extraCameras, peopleOnCamera);

  const total =
    baseSubtotal +
    engineerSubtotal +
    extrasSession +
    extraCamsSubtotal +
    postProdSubtotal;

  return {
    total,
    totalCams,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extrasSession,
      extraCamsSubtotal,
      postProd: postProdSubtotal,
    },
    hours,
    mode,
  };
}

// ---------- Routes ----------
app.get('/env-check', (_req, res) => {
  res.json({
    hasKey: !!stripeSecret,
    mode: envModeFromKey(stripeSecret),
    port: String(PORT),
  });
});

app.post('/quote', (req, res) => {
  try {
    res.json(computeQuote(req.body));
  } catch (e) {
    res.status(400).json({ error: 'Bad Request', detail: String(e) });
  }
});

app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const b = req.body || {};
    const q = computeQuote(b);
    const items = [];

    // Base hourly — name reflects chosen mode
    const baseName =
      q.mode === 'AUDIO_ONLY' ? 'Studio booking (Audio Only)' : 'Studio booking (One Camera)';
    const baseUnit = (q.mode === 'AUDIO_ONLY' ? HOURLY_AUDIO_ONLY : HOURLY_ONE_CAMERA) * 100;
    items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: baseName },
        unit_amount: baseUnit,
      },
      quantity: q.hours,
    });

    // Engineer hourly
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

    // Add-ons (flat)
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
    if (b.remoteGuest) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Remote Guest' },
          unit_amount: REMOTE_GUEST_FEE * 100,
        },
        quantity: 1,
      });
    }
    if (b.adClips5) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: '+5 Ad Clips' },
          unit_amount: AD_CLIPS_5_FEE * 100,
        },
        quantity: 1,
      });
    }
    if (b.mediaSdOrUsb) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Media to SD/USB' },
          unit_amount: MEDIA_SD_USB_FEE * 100,
        },
        quantity: 1,
      });
    }

    // Extra cameras (flat × count)
    const extraCameras = Math.max(0, n(b.extraCameras, 0));
    if (extraCameras > 0) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Extra Camera' },
          unit_amount: EXTRA_CAMERA_FEE * 100,
        },
        quantity: extraCameras,
      });
    }

    // Post production: charge the total tiered amount as a single line
    const pp = Math.max(0, n(b.postProduction, 0));
    if (pp > 0) {
      const subtotalCents = postProdTiered(pp) * 100;
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `Post Production (${pp} cam${pp > 1 ? 's' : ''})` },
          unit_amount: subtotalCents,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items,
      allow_promotion_codes: true, // customer can enter coupons at checkout
      success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: CANCEL_URL,
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: 'Checkout failed', detail: String(err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
