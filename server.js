// server.js — VU Studio Booking API (ESM)
// Modes supported:
//   - ONE_CAMERA     ($55/hr) + optional engineer $20/hr + extras + post-prod tier
//   - AUDIO_ONLY     ($45/hr) + optional engineer $20/hr + extras + post-prod tier
//   - MUSIC          ($75/hr, or $65/hr if hours >=4); engineer included (no fee) + music add-ons
//
// Common constraints enforced server-side:
//   - Hours: 2–6
//   - Start time: 10:00–19:00 (end may go later)
//   - Date: at least 3 days from today; Sundays are not allowed

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// ---- CORS ----
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin,
  })
);

// ---- Stripe ----
const stripeSecret =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  null;

const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: '2024-06-20' })
  : null;

// ---- Success/Cancel ----
const SUCCESS_URL =
  process.env.SUCCESS_URL || 'https://vizionzunlimited.com/bookingsuccess';
const CANCEL_URL =
  process.env.CANCEL_URL || 'https://vizionzunlimited.com/bookingcancel';

const PORT = process.env.PORT || 10000;

// ---------- utils ----------
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
function parseHHMM(str) {
  // returns { hh, mm } or null
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hh: n(m[1]), mm: n(m[2]) };
}
function isDateAtLeastDaysOutISO(isoYYYYMMDD, days) {
  if (!isoYYYYMMDD) return false;
  const chosen = new Date(`${isoYYYYMMDD}T00:00:00`);
  if (Number.isNaN(chosen.getTime())) return false;
  chosen.setHours(0, 0, 0, 0);

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const min = new Date(now);
  min.setDate(min.getDate() + days);
  return chosen >= min;
}
function isSundayISO(isoYYYYMMDD) {
  if (!isoYYYYMMDD) return false;
  const d = new Date(`${isoYYYYMMDD}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  return d.getDay() === 0;
}

// ---------- PRICING (STUDIO) ----------
const HOURLY_ONE_CAMERA = 55;
const HOURLY_AUDIO_ONLY = 45;
const HOURLY_ENGINEER   = 20;

const TELEPROMPTER_FEE  = 25;
const REMOTE_GUEST_FEE  = 10;
const AD_CLIPS_5_FEE    = 150;
const MEDIA_SD_USB_FEE  = 50;

const EXTRA_CAMERA_FEE  = 25; // per extra camera (flat/session)

function postProdTiered(cams) {
  const c = Math.max(0, n(cams, 0));
  if (c === 0) return 0;
  return 200 + (c - 1) * 100; // 1->200, 2->300, 3->400...
}

// ---------- PRICING (MUSIC) ----------
const MUSIC_STD_HOURLY      = 75; // < 4 hours
const MUSIC_DISCOUNT_HOURLY = 65; // >= 4 hours

const VIDEO_SESSION_FEE     = 75;   // flat
const MIXING_FEE            = 200;  // flat
const MASTERING_FEE         = 50;   // flat
const BEAT_PRODUCTION_FEE   = 100;  // flat
const VOCAL_TUNING_PER_SONG = 50;   // per song
const MUSICIAN_HOURLY       = 80;   // per hour
const ALBUM_ARTWORK_FEE     = 150;  // flat

const MIN_HOURS = 2;
const MAX_HOURS = 6;

// ---------- Quote calculators ----------
function computeStudioQuote(body = {}) {
  const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, n(body.hours, 2)));
  const mode  = (body.mode || 'ONE_CAMERA').toUpperCase();

  const baseHourly = mode === 'AUDIO_ONLY' ? HOURLY_AUDIO_ONLY : HOURLY_ONE_CAMERA;
  const baseSubtotal = hours * baseHourly;

  const engChoice = (body.engineerChoice || 'any').toLowerCase();
  const engineerHourly = engChoice === 'none' ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // session extras
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0);

  // extra cameras
  const extraCameras = Math.max(0, n(body.extraCameras, 0));
  const extraCamsSubtotal = extraCameras * EXTRA_CAMERA_FEE;

  // post prod tiered
  const postProduction = Math.max(0, n(body.postProduction, 0));
  const postProd = postProdTiered(postProduction);

  const peopleOnCamera = Math.max(1, n(body.peopleOnCamera, 1));
  const totalCams = Math.max(1, 1 + extraCameras, peopleOnCamera);

  const total = baseSubtotal + engineerSubtotal + extrasSession + extraCamsSubtotal + postProd;

  return {
    mode,
    hours,
    total,
    totalCams,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extrasSession,
      extraCamsSubtotal,
      postProd,
    },
  };
}

function computeMusicQuote(body = {}) {
  const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, n(body.hours, 2)));
  const baseHourly = hours >= 4 ? MUSIC_DISCOUNT_HOURLY : MUSIC_STD_HOURLY;
  const baseSubtotal = hours * baseHourly;

  // add-ons
  let addons = 0;
  if (body.videoSession)    addons += VIDEO_SESSION_FEE;
  if (body.mixing)          addons += MIXING_FEE;
  if (body.mastering)       addons += MASTERING_FEE;
  if (body.beatProduction)  addons += BEAT_PRODUCTION_FEE;

  const songs = Math.max(0, n(body.vocalSongCount, 0));
  const vocalTuningSubtotal = songs * VOCAL_TUNING_PER_SONG;
  addons += vocalTuningSubtotal;

  let musHours = Math.max(0, n(body.musicianHours, 0));
  if (musHours === 0) musHours = hours; // default: same as session hours
  const musicianSubtotal = musHours * MUSICIAN_HOURLY;
  addons += musicianSubtotal;

  if (body.albumArtwork) addons += ALBUM_ARTWORK_FEE;

  const total = baseSubtotal + addons;

  return {
    mode: 'MUSIC',
    hours,
    total,
    breakdown: {
      baseSubtotal,
      baseHourly,
      addonsSubtotal: addons,
      vocalTuningSubtotal,
      musicianSubtotal,
    },
  };
}

function computeQuote(body = {}) {
  const mode = (body.mode || 'ONE_CAMERA').toUpperCase();
  if (mode === 'MUSIC') return computeMusicQuote(body);
  return computeStudioQuote(body);
}

// ---------- Validation (applies to all modes) ----------
function validateBookingOrThrow(b = {}) {
  // Date rules: >= 3 days out, not Sunday
  if (!b.date) {
    throw new Error('Missing date.');
  }
  if (isSundayISO(b.date)) {
    throw new Error('Sundays are not available.');
  }
  if (!isDateAtLeastDaysOutISO(b.date, 3)) {
    throw new Error('Please pick a date at least 3 days from today.');
  }

  // Hours 2–6
  const hours = n(b.hours, 0);
  if (hours < MIN_HOURS || hours > MAX_HOURS) {
    throw new Error('Hours must be between 2 and 6.');
  }

  // Start time 10:00–19:00 (inclusive)
  if (!b.startTime) throw new Error('Missing start time.');
  const hhmm = parseHHMM(b.startTime);
  if (!hhmm) throw new Error('Invalid start time.');
  if (hhmm.hh < 10 || hhmm.hh > 19) {
    throw new Error('Start time must be between 10:00 and 19:00.');
  }

  // Basic contact
  if (!b.name || !b.email || !b.phone) {
    throw new Error('Please provide name, email, and phone.');
  }
}

// ---------- Routes ----------
app.get('/env-check', (_req, res) => {
  res.json({
    hasKey: !!stripeSecret,
    mode: envModeFromKey(stripeSecret),
    port: String(PORT),
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
  });
});

app.post('/quote', (req, res) => {
  try {
    // optional: enforce date/time constraints even on quotes
    validateBookingOrThrow(req.body || {});
    const q = computeQuote(req.body || {});
    res.json(q);
  } catch (e) {
    res.status(400).json({ error: 'Bad Request', detail: String(e.message || e) });
  }
});

// A debug echo (handy for quick checks)
app.post('/quote-debug', (req, res) => {
  try {
    const received = req.body || {};
    const totals = computeQuote(received);
    res.json({ received, totals });
  } catch (e) {
    res.status(400).json({ error: 'Bad Request', detail: String(e.message || e) });
  }
});

app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const b = req.body || {};
    validateBookingOrThrow(b);
    const q = computeQuote(b);

    const items = [];

    if (q.mode === 'MUSIC') {
      // Base hourly
      const baseName = 'Music Recording Session';
      const unitCents = Math.round((q.breakdown.baseHourly || (q.hours >= 4 ? MUSIC_DISCOUNT_HOURLY : MUSIC_STD_HOURLY)) * 100);
      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: baseName },
          unit_amount: unitCents,
        },
        quantity: q.hours,
      });

      // Add-ons
      if (b.videoSession) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Video recording of the session' }, unit_amount: VIDEO_SESSION_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.mixing) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Mixing' }, unit_amount: MIXING_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.mastering) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Mastering' }, unit_amount: MASTERING_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.beatProduction) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Beat Production & Instrumental' }, unit_amount: BEAT_PRODUCTION_FEE * 100 },
          quantity: 1,
        });
      }
      const songs = Math.max(0, n(b.vocalSongCount, 0));
      if (songs > 0) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Vocal Tuning & Editing' }, unit_amount: VOCAL_TUNING_PER_SONG * 100 },
          quantity: songs,
        });
      }
      let musHours = Math.max(0, n(b.musicianHours, 0));
      if (musHours === 0) musHours = q.hours;
      if (musHours > 0) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Session Musicians' }, unit_amount: MUSICIAN_HOURLY * 100 },
          quantity: musHours,
        });
      }
      if (b.albumArtwork) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Album Artwork' }, unit_amount: ALBUM_ARTWORK_FEE * 100 },
          quantity: 1,
        });
      }
    } else {
      // STUDIO: ONE_CAMERA / AUDIO_ONLY
      const baseName =
        q.mode === 'AUDIO_ONLY' ? 'Studio booking (Audio Only)' : 'Studio booking (One Camera)';
      const baseHourly =
        q.mode === 'AUDIO_ONLY' ? HOURLY_AUDIO_ONLY : HOURLY_ONE_CAMERA;

      items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: baseName },
          unit_amount: baseHourly * 100,
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
          price_data: { currency: 'usd', product_data: { name: 'Teleprompter' }, unit_amount: TELEPROMPTER_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.remoteGuest) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Remote Guest' }, unit_amount: REMOTE_GUEST_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.adClips5) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: '+5 Ad Clips' }, unit_amount: AD_CLIPS_5_FEE * 100 },
          quantity: 1,
        });
      }
      if (b.mediaSdOrUsb) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Media to SD/USB' }, unit_amount: MEDIA_SD_USB_FEE * 100 },
          quantity: 1,
        });
      }

      // Extra cameras
      const extraCams = Math.max(0, n(b.extraCameras, 0));
      if (extraCams > 0) {
        items.push({
          price_data: { currency: 'usd', product_data: { name: 'Extra Camera' }, unit_amount: EXTRA_CAMERA_FEE * 100 },
          quantity: extraCams,
        });
      }

      // Post production tiered — charge as single line item for the total
      const pp = Math.max(0, n(b.postProduction, 0));
      const ppSubtotal = postProdTiered(pp);
      if (ppSubtotal > 0) {
        items.push({
          price_data: {
            currency: 'usd',
            product_data: { name: `Post Production (${pp} cam${pp > 1 ? 's' : ''})` },
            unit_amount: ppSubtotal * 100,
          },
          quantity: 1,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items,
      allow_promotion_codes: true,
      success_url: SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: CANCEL_URL,
      // Optional: attach metadata you want to see inside Stripe
      metadata: {
        mode: (b.mode || '').toString(),
        name: (b.name || '').toString(),
        email: (b.email || '').toString(),
        phone: (b.phone || '').toString(),
        date: (b.date || '').toString(),
        startTime: (b.startTime || '').toString(),
        hours: (b.hours || '').toString(),
      },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: 'Checkout failed', detail: String(err.message || err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
