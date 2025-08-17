// server.js — VU Studio Booking API (ESM)
// Stripe Checkout with pricing that matches the booking page.

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// CORS (set CORS_ORIGIN in Render if you want to restrict)
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin,
  })
);

// Stripe secret (Render env var: STRIPE_SECRET_KEY recommended)
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
function num(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

// ---------- PRICING (MATCHES PAGE) ----------
const HOURLY_BASE_ONE_CAM = 55;   // $55/hr (base)
const HOURLY_ENGINEER     = 20;   // $20/hr (if engineer != none)

const EXTRA_CAMERA_FEE    = 100;  // $100 per extra camera (flat per session)

const TELEPROMPTER_FEE    = 25;   // session add-ons
const REMOTE_GUEST_FEE    = 10;
const AD_CLIPS_5_FEE      = 150;
const MEDIA_SD_USB_FEE    = 50;

const POST_PROD_PER_CAM   = 200;  // $200 per cam to edit
const MIN_HOURS           = 2;

// ---------- Quote calculator ----------
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, num(body.hours, 2));
  const mode  = body.mode || 'ONE_CAMERA';

  // Base (hourly)
  const baseSubtotal = hours * HOURLY_BASE_ONE_CAM;

  // Engineer (hourly if not "none")
  const engineerChoice  = (body.engineerChoice || 'any').toLowerCase();
  const engineerHourly  = engineerChoice === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // Extra cameras (flat per session)
  const extraCameras = Math.max(0, num(body.extraCameras, 0));
  const extraCamsSubtotal = extraCameras * EXTRA_CAMERA_FEE;

  // Session add-ons
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // Post production
  const postProduction   = Math.max(0, num(body.postProduction, 0));
  const postProdSubtotal = postProduction === 0 ? 0 : postProduction * POST_PROD_PER_CAM;

  // FYI camera count (not used for price directly)
  const peopleOnCamera = Math.max(1, num(body.peopleOnCamera, 1));
  const totalCams      = Math.max(1, 1 + extraCameras, peopleOnCamera);

  const total =
    baseSubtotal +
    engineerSubtotal +
    extraCamsSubtotal +
    extrasSession +
    postProdSubtotal;

  return {
    total,
    totalCams,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extraCamsSubtotal, // << shown separately
      extrasSession,
      postProd: postProdSubtotal,
    },
    hours,
    mode,
  };
}

// ---------- Routes ----------
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

    // Base booking (hourly)
    items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: `Studio booking (${q.mode})` },
        unit_amount: HOURLY_BASE_ONE_CAM * 100,
      },
      quantity: q.hours,
    });

    // Engineer (hourly)
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

    // Extra cameras (flat per cam)
    const extraCameras = Math.max(0, num(b.extraCameras, 0));
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

    // Teleprompter (flat)
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

    // Remote guest (flat)
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

    // +5 Ad Clips (flat)
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

    // Media to SD/USB (flat)
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

    // Post production (per cam to edit)
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

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: 'Checkout failed', detail: String(err) });
  }
});

app.get('/env-check', (_req, res) => {
  res.json({ hasKey: !!stripeSecret, port: String(PORT) });
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
