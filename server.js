// server.js — VU Studio Booking API with Coupons (Promo Codes)
//
// Set these in Render → Environment:
//   STRIPE_SECRET_KEY     (your sk_test_... or sk_live_...)
//   SUCCESS_URL           (https://your-site.com/success.html)
//   CANCEL_URL            (https://your-site.com/cancel.html)
// Optional:
//   CORS_ORIGIN           (frontend origin or *)
//   PORT                  (Render injects 10000)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const PORT = process.env.PORT || 5000;

const STRIPE_KEY =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET_KEY_TEST ||
  process.env.STRIPE_SECRET_KEY_LIVE ||
  '';

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

const SUCCESS_URL = process.env.SUCCESS_URL || 'https://example.com/success.html';
const CANCEL_URL  = process.env.CANCEL_URL  || 'https://example.com/cancel.html';

// ---------- Pricing calculator (single source of truth) ----------
function computeTotals(b = {}) {
  // Normalize hours: first-time min 2, absolute min 1, max 6
  const isFirst = !!b.isFirstTime;
  let hours = Number(b.hours) || 0;
  if (isFirst && hours < 2) hours = 2;
  if (hours < 1) hours = 1;
  if (hours > 6) hours = 6;

  // Session mode: AUDIO_ONLY ($45/hr) or ONE_CAMERA ($55/hr)
  const mode = String(b.mode || 'ONE_CAMERA').toUpperCase();
  const baseRate = (mode === 'AUDIO_ONLY') ? 45 : 55;

  // Cameras included by mode (AUDIO_ONLY=0, ONE_CAMERA=1)
  const baseIncludedCams = (mode === 'AUDIO_ONLY') ? 0 : 1;

  // Extra cameras (flat per session, not hourly)
  const extraCameras = Math.max(0, Number(b.extraCameras) || 0);

  // Start with package cameras + extras
  let totalCams = baseIncludedCams + extraCameras;

  // Let "People on Camera" raise the reported cam count (display/fallback only; no price impact)
  const peopleOnCamera = Math.max(0, Number(b.peopleOnCamera) || 0);
  totalCams = Math.max(totalCams, peopleOnCamera);

  // Engineer fee (+$20/hr) unless "none"
  const engineerChoice = String(b.engineerChoice || 'any').toLowerCase(); // any | specific | none
  const wantsEngineer = engineerChoice !== 'none';

  // Subtotals
  const baseSubtotal = baseRate * hours;
  const engineerSubtotal = wantsEngineer ? (20 * hours) : 0;

  // Per-session add-ons (flat)
  let extrasSession = 0;
  if (extraCameras > 0) extrasSession += extraCameras * 25; // $25 each
  if (b.remoteGuest)    extrasSession += 10;                // $10
  if (b.teleprompter)   extrasSession += 25;                // $25
  if (b.adClips5)       extrasSession += 150;               // $150
  if (b.mediaSdOrUsb)   extrasSession += 50;                // $50

  // Post-production tiers based on cams to edit:
  // None(0)=$0, 1=$200, 2=$250, 3=$300, 4=$350
  // If client explicitly sets 0 -> $0
  // If undefined/null -> fallback to totalCams (cap at 4)
  const postTier = { 0: 0, 1: 200, 2: 250, 3: 300, 4: 350 };
  let camsForPost;
  if (b.postProduction === 0) {
    camsForPost = 0; // explicit None
  } else if (b.postProduction == null || b.postProduction === '') {
    camsForPost = Math.min(4, totalCams); // fallback uses (possibly raised) totalCams
  } else {
    camsForPost = Math.min(4, Number(b.postProduction) || 0);
  }
  const postProd = postTier[camsForPost] ?? 0;

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

  return {
    breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd },
    total,
    totalCams
  };
}

// ---------- Optional: server-side business rule validation ----------
function validateBusinessRules(b) {
  // Date ≥ 2 days out & Mon–Fri
  if (b.date) {
    const today = new Date(); today.setHours(0,0,0,0);
    const min = new Date(today); min.setDate(min.getDate() + 2);
    const sel = new Date(`${b.date}T00:00:00`);
    if (sel < min) return 'Date must be at least 2 days from today.';
    const dow = sel.getDay(); // 0 Sun..6 Sat
    if (dow === 0 || dow === 6) return 'Bookings are Monday–Friday only.';
  }
  // Start time must be 10:00–19:00 (end may go past 19:00)
  if (b.startTime) {
    const [H, M] = String(b.startTime).split(':').map(Number);
    const start = H * 60 + (M || 0);
    const open = 10 * 60, close = 19 * 60;
    if (start < open || start > close) return 'Start time must be between 10:00 AM and 7:00 PM.';
  }
  // Hours min 2, max 6
  const isFirst = !!b.isFirstTime;
  const hours = Number(b.hours) || 0;
  if (isFirst && hours < 2) return 'First-time bookings must be at least 2 hours.';
  if (hours < 2) return 'Minimum booking is 2 hours.';
  if (hours > 6) return 'Maximum booking is 6 hours.';
  return '';
}

// ---------- Stripe coupon helpers ----------
async function lookupPromotionCode(code) {
  if (!stripe || !code) return null;
  const list = await stripe.promotionCodes.list({
    code: String(code).trim(),
    active: true,
    limit: 1,
    expand: ['data.coupon']
  });
  return list.data[0] || null;
}

function applyCouponToTotal(total, coupon) {
  if (!coupon) return { discountedTotal: total, discountAmount: 0 };
  const { percent_off, amount_off, currency } = coupon;

  if (percent_off) {
    const discountAmount = Math.round(total * (percent_off / 100));
    return { discountedTotal: Math.max(0, total - discountAmount), discountAmount };
  }
  if (amount_off && (!currency || String(currency).toLowerCase() === 'usd')) {
    const discountAmount = Math.min(total, amount_off);
    return { discountedTotal: Math.max(0, total - discountAmount), discountAmount };
  }
  return { discountedTotal: total, discountAmount: 0 };
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.json({ ok: true, service: 'vu-studio-booking-api' }));

app.get('/env-check', (_req, res) => {
  res.json({
    mode: STRIPE_KEY?.startsWith('sk_live_') ? 'live' : 'test',
    hasKey: !!STRIPE_KEY,
    port: String(PORT)
  });
});

// Quote with optional coupon code
app.post('/quote', async (req, res) => {
  try {
    const booking = req.body || {};

    const violation = validateBusinessRules(booking);
    if (violation) return res.status(400).json({ error: violation });

    const totals = computeTotals(booking);

    // Coupon (optional)
    let discount = { discountedTotal: totals.total, discountAmount: 0 };
    let promoSummary = null;

    if (booking.couponCode) {
      const promo = await lookupPromotionCode(booking.couponCode);
      if (promo?.coupon) {
        discount = applyCouponToTotal(totals.total, promo.coupon);
        promoSummary = {
          code: promo.code,
          coupon: {
            id: promo.coupon.id,
            percent_off: promo.coupon.percent_off || null,
            amount_off: promo.coupon.amount_off || null,
            currency: promo.coupon.currency || 'usd'
          }
        };
      }
    }

    res.json({
      ...totals,
      discount: { amount: discount.discountAmount, code: promoSummary?.code || null },
      total: discount.discountedTotal, // show discounted total
      promo: promoSummary
    });
  } catch (err) {
    console.error('QUOTE error', err);
    res.status(400).json({ error: 'Bad Request', detail: err?.message });
  }
});

// Debug echo
app.post('/quote-debug', async (req, res) => {
  try {
    const booking = req.body || {};
    const totals = computeTotals(booking);
    res.json({ received: booking, totals });
  } catch (err) {
    res.status(400).json({ error: 'Bad Request', detail: err?.message });
  }
});

// Checkout — pre-apply coupon if present; otherwise allow entry on Stripe
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }
    const booking = req.body || {};

    const violation = validateBusinessRules(booking);
    if (violation) return res.status(400).json({ error: violation });

    const totals = computeTotals(booking);
    const hours = Math.max(1, Math.min(6, Number(booking.hours) || 1));
    const mode = String(booking.mode || 'ONE_CAMERA').replace('_', ' ');
    const baseRate = String(booking.mode || 'ONE_CAMERA').toUpperCase() === 'AUDIO_ONLY' ? 45 : 55;

    const line_items = [];

    // Base per-hour
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

    // Engineer per-hour
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

    // Session add-ons (flat)
    if (totals.breakdown.extrasSession > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(totals.breakdown.extrasSession * 100),
          product_data: { name: 'Session add-ons' }
        },
        quantity: 1
      });
    }

    // Post-production (flat)
    if (totals.breakdown.postProd > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(totals.breakdown.postProd * 100),
          product_data: {
            name: `Post-production (${totals.totalCams} cam${totals.totalCams === 1 ? '' : 's'})`
          }
        },
        quantity: 1
      });
    }

    // Discounts
    let discounts = [];
    if (booking.couponCode) {
      const promo = await lookupPromotionCode(booking.couponCode);
      if (promo) {
        discounts = [{ promotion_code: promo.id }];
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      line_items,
      discounts: discounts.length ? discounts : undefined, // pre-apply if valid
      allow_promotion_codes: discounts.length ? undefined : true, // else let them add one
      metadata: {
        customerName: booking?.customer?.name || '',
        date: booking?.date || '',
        startTime: booking?.startTime || '',
        totalBeforeDiscount: String(totals.total),
        couponCode: booking?.couponCode || ''
      }
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('CHECKOUT error', err);
    res.status(400).json({ error: 'Checkout error', detail: err?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
