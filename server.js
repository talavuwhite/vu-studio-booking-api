// server.js  — VU Studio Booking API (pricing + quote + checkout)
//
// Env you should set on Render:
//   STRIPE_SECRET_KEY              (or STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY_LIVE)
//   SUCCESS_URL                    (e.g. https://your-site.com/success.html)
//   CANCEL_URL                     (e.g. https://your-site.com/cancel.html)
// Optional:
//   CORS_ORIGIN                    (frontend origin or *)
//   PORT                           (Render injects 10000 for you)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Choose whichever Stripe key you’ve provided
const STRIPE_KEY =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  '';

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

const SUCCESS_URL =
  process.env.SUCCESS_URL ||
  'https://example.com/success.html'; // change in Render

const CANCEL_URL =
  process.env.CANCEL_URL ||
  'https://example.com/cancel.html'; // change in Render

// ---------- Pricing logic in ONE place ----------
function computeTotals(b = {}) {
  // Normalize hours (min 1, max 6; first-time min 2)
  let hours = Number(b.hours) || 0;
  const isFirst = !!b.isFirstTime;
  if (isFirst && hours < 2) hours = 2;
  if (hours < 1) hours = 1;
  if (hours > 6) hours = 6;

  // Session mode
  const mode = String(b.mode || 'ONE_CAMERA').toUpperCase(); // 'AUDIO_ONLY' or 'ONE_CAMERA'
  const baseRate = mode === 'AUDIO_ONLY' ? 45 : 55; // $/hr

  // Cameras
  const baseIncludedCams = mode === 'AUDIO_ONLY' ? 0 : 1;
  const extraCameras = Math.max(0, Number(b.extraCameras) || 0);
  const totalCams = baseIncludedCams + extraCameras;

  // Engineer
  const engineerChoice = String(b.engineerChoice || 'any').toLowerCase(); // any | specific | none
  const wantsEngineer = engineerChoice !== 'none';

  // Subtotals
  const baseSubtotal = baseRate * hours;
  const engineerSubtotal = wantsEngineer ? 20 * hours : 0; // $20/hr

  // Per‑session add‑ons (flat)
  let extrasSession = 0;
  if (extraCameras > 0) extrasSession += extraCameras * 25; // $25 each
  if (b.remoteGuest) extrasSession += 10;                    // $10
  if (b.teleprompter) extrasSession += 25;                   // $25
  if (b.adClips5) extrasSession += 75;                       // $75
  if (b.mediaSdOrUsb) extrasSession += 50;                   // $50

  // Post‑production: by # of cams to edit (cap at 4)
  const camsForPost = Math.min(4, Number(b.postProduction) || totalCams);
  const postTier = { 0: 0, 1: 200, 2: 250, 3: 300, 4: 350 };
  const postProd = postTier[camsForPost] ?? 0;

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

  return {
    breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd },
    total,
    totalCams
  };
}
// -----------------------------------------------

// Health
app.get('/', (_req, res) => res.json({ ok: true, service: 'vu-studio-booking-api' }));

// Quick environment sanity check
app.get('/env-check', (_req, res) => {
  res.json({
    mode: STRIPE_KEY?.startsWith('sk_live_') ? 'live' : 'test',
    hasGenericKey: !!process.env.STRIPE_SECRET_KEY,
    hasTestKey: !!process.env.STRIPE_SECRET_KEY_TEST,
    hasLiveKey: !!process.env.STRIPE_SECRET_KEY_LIVE,
    keyLength: (STRIPE_KEY || '').length,
    port: String(PORT)
  });
});

// Totals only
app.post('/quote', (req, res) => {
  try {
    const totals = computeTotals(req.body || {});
    res.json(totals);
  } catch (err) {
    res.status(400).json({ error: 'Bad Request', detail: err?.message });
  }
});

// Echo + totals (handy for debugging)
app.post('/quote-debug', (req, res) => {
  try {
    const totals = computeTotals(req.body || {});
    res.json({ received: req.body, totals });
  } catch (err) {
    res.status(400).json({ error: 'Bad Request', detail: err?.message });
  }
});

// Create Stripe Checkout Session
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: 'Stripe key missing. Set STRIPE_SECRET_KEY (or *_TEST) in Render.' });
    }

    const booking = req.body || {};
    const totals = computeTotals(booking);

    const hours = Math.max(1, Math.min(6, Number(booking.hours) || 1));
    const mode = String(booking.mode || 'ONE_CAMERA').replace('_', ' ');
    const baseRate = String(booking.mode || 'ONE_CAMERA').toUpperCase() === 'AUDIO_ONLY' ? 45 : 55;

    const line_items = [];

    // Base session (per hour)
    line_items.push({
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(baseRate * 100),
        product_data: {
          name: `Studio booking (${mode})`,
          description: `${hours} hour${hours > 1 ? 's' : ''}`
        }
      },
      quantity: hours
    });

    // Engineer (per hour)
    if (totals.breakdown.engineerSubtotal > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: 2000,
          product_data: { name: 'Studio Engineer' }
        },
        quantity: hours
      });
    }

    // Session add‑ons (flat)
    if (totals.breakdown.extrasSession > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(totals.breakdown.extrasSession * 100),
          product_data: { name: 'Session add‑ons' }
        },
        quantity: 1
      });
    }

    // Post production
    if (totals.breakdown.postProd > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(totals.breakdown.postProd * 100),
          product_data: {
            name: `Post‑production (${totals.totalCams} cam${totals.totalCams === 1 ? '' : 's'})`
          }
        },
        quantity: 1
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      line_items,
      metadata: {
        customerName: booking?.customer?.name || '',
        date: booking?.date || '',
        startTime: booking?.startTime || '',
        total: String(totals.total)
      }
    });

    res.json({ checkoutUrl: session.url, totals });
  } catch (err) {
    console.error('Checkout error', err);
    res.status(400).json({ error: 'Checkout error', detail: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
