// server.js — VU Studio Booking API (pricing + quote + checkout)
// --------------------------------------------------------------
// ENV you should set on Render:
//   STRIPE_SECRET_KEY            (live key: sk_live_...)
//   SUCCESS_URL                  (e.g. https://vizionzunlimited.com/bookingsuccess)
//   CANCEL_URL                   (e.g. https://vizionzunlimited.com/bookingcancel)
// Optional:
//   CORS_ORIGIN                  (frontend origin or *)
//   PORT                         (Render injects 10000)

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

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

const stripe =
  stripeSecret
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

// Pricing rules (adjust here if needed)
const HOURLY_BASE_ONE_CAM = 55;  // $55/hr
const HOURLY_ENGINEER = 20;      // $20/hr if an engineer is selected
const TELEPROMPTER_FEE = 25;     // flat per session
const REMOTE_GUEST_FEE = 0;      // adjust if you want to charge
const AD_CLIPS_5_FEE = 0;        // adjust if you want to charge
const MEDIA_SD_USB_FEE = 0;      // adjust if you want to charge
const POST_PROD_PER_CAM = 100;   // $100 per camera to edit
const MIN_HOURS = 2;

/**
 * Calculate totals & breakdown.
 * Enforces: min 2 hours; postProduction=0 => $0 (no charge).
 * People on camera may influence camera count (not price).
 */
function computeQuote(body) {
  const hours = Math.max(MIN_HOURS, num(body.hours, 2));
  const mode = body.mode || 'ONE_CAMERA';

  // Base subtotal (pricing currently the same regardless of "peopleOnCamera")
  const baseHourly = HOURLY_BASE_ONE_CAM;
  const baseSubtotal = hours * baseHourly;

  // Engineer logic — if user did NOT choose "none", we charge engineer time
  const engineerChoice = (body.engineerChoice || 'any').toLowerCase();
  const engineerHourly = engineerChoice === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // Extras (per session)
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // Post production — **0 means none => $0**
  const postProduction = Math.max(0, num(body.postProduction, 0));
  const postProdSubtotal = postProduction === 0
    ? 0
    : postProduction * POST_PROD_PER_CAM;

  // Cameras used (for FYI display only; does NOT change price)
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
    const q = computeQuote(req.body || {});
    res.json(q);
  } catch (e) {
    res.status(400).json({ error: 'Bad Request', detail: String(e) });
  }
});

// Small debug echo to see exactly what the server received
app.post('/quote-debug', (req, res) => {
  const received = req.body || {};
  const totals = computeQuote(received);
  res.json({ received, totals });
});

/**
 * Create Stripe Checkout Session.
 * Returns BOTH checkoutUrl and sessionId so you can verify in the Stripe Dashboard.
 * Allows promotion codes so customers can enter coupons at checkout.
 */
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const b = req.body || {};
    const q = computeQuote(b);

    // Build line items with itemization similar to your screenshots
    const items = [];

    // Base booking
    items.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Studio booking (${q.mode})`,
        },
        unit_amount: HOURLY_BASE_ONE_CAM * 100, // $55/hr
      },
      quantity: q.hours,
    });

    // Engineer time
    if (q.breakdown.engineerSubtotal > 0) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Studio Engineer' },
          unit_amount: HOURLY_ENGINEER * 100, // $20/hr
        },
        quantity: q.hours,
      });
    }

    // Teleprompter (add others the same way if you begin charging for them)
    if (b.teleprompter) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Teleprompter' },
          unit_amount: TELEPROMPTER_FEE * 100, // $25 per session
        },
        quantity: 1,
      });
    }

    // Post production (0 => no line item)
    const postProduction = Math.max(0, num(b.postProduction, 0));
    if (postProduction > 0) {
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Post Production (cams to edit)' },
          unit_amount: POST_PROD_PER_CAM * 100, // $100 per camera
        },
        quantity: postProduction,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items,
      allow_promotion_codes: true, // coupon entry on Stripe page
      success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: CANCEL_URL,
    });

    return res.json({
      checkoutUrl: session.url,
      sessionId: session.id, // <-- added so you can search for it in Stripe
    });
  } catch (err) {
    console.error('checkout error:', err);
    return res.status(400).json({ error: 'Checkout failed', detail: String(err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
