// server.js — VU Studio Booking API (ESM)
//
// Matches the booking page:
// - Extra cameras: $25 each (flat per session)
// - Post production: $200 first cam + $100 each additional
// - Engineer: $20/hr when engineer != "none"
// - Base hourly: $55/hr
//
// Stripe Checkout session items mirror the UI exactly.

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// CORS (lock this down later to your domain if you want)
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

// Success/Cancel redirect URLs
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

// ---------- PRICING (MATCHES CLIENT) ----------
const HOURLY_BASE_ONE_CAM = 55;   // $55/hr
const HOURLY_ENGINEER     = 20;   // $20/hr if engineer != "none"

const EXTRA_CAMERA_FEE    = 25;   // $25 per extra camera (flat per session)

const TELEPROMPTER_FEE    = 25;   // add-ons (flat)
const REMOTE_GUEST_FEE    = 10;
const AD_CLIPS_5_FEE      = 150;
const MEDIA_SD_USB_FEE    = 50;

const MIN_HOURS = 2;

/** tiered post-production: 0 -> $0, 1 -> $200, 2 -> $300, 3 -> $400, ... */
function postProdTiered(cams) {
  const c = Math.max(0, n(cams, 0));
  if (c === 0) return 0;
  return 200 + (c - 1) * 100;
}

// ---------- Quote calc ----------
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, n(body.hours, 2));
  const mode  = (body.mode || 'ONE_CAMERA').toUpperCase();

  // Base hourly
  const baseSubtotal = hours * HOURLY_BASE_ONE_CAM;

  // Engineer hourly (if not "none")
  const engSel = (body.engineerChoice || 'any').toLowerCase();
  const engHr  = engSel === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engHr;

  // Extra cameras (flat per cam)
  const extraCameras      = Math.max(0, n(body.extraCameras, 0));
  const extraCamsSubtotal = extraCameras * EXTRA_CAMERA_FEE;

  // Session add-ons
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // Tiered post-prod
  const postProduction      = Math.max(0, n(body.postProduction, 0));
  const postProdSubtotalUSD = postProdTiered(postProduction);

  // FYI camera count (not charging by people)
  const peopleOnCamera = Math.max(1, n(body.peopleOnCamera, 1));
  const totalCams      = Math.max(1, 1 + extraCameras, peopleOnCamera);

  const total =
    baseSubtotal +
    engineerSubtotal +
    extraCamsSubtotal +
    extrasSession +
    postProdSubtotalUSD;

  return {
    total,
    totalCams,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extraCamsSubtotal,
      extrasSession,
      postProd: postProdSubtotalUSD,
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

    // Base hourly
    items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: `Studio booking (${q.mode})` },
        unit_amount: HOURLY_BASE_ONE_CAM * 100,
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

    // Extra cameras (flat)
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

    // Post-production (tiered)
    const pp = Math.max(0, n(b.postProduction, 0));
    if (pp > 0) {
      // charge the total tiered amount as a single line item for clarity
      const subtotalCents = postProdTiered(pp) * 100;
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `Post Production (${pp} cam${pp>1?'s':''})` },
          unit_amount: subtotalCents,
        },
        quantity: 1,
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
