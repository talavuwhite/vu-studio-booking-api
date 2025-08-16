// server.js — VU Studio Booking API
// Pricing + Quote + Checkout + Discount preview + On-page payment

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// CORS
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));

// Stripe
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || '';
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: '2023-10-16' }) : null;

// Success/Cancel
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://example.com/success.html';
const CANCEL_URL  = process.env.CANCEL_URL  || 'https://example.com/cancel.html';

// ---- Pricing function (same logic we’ve been using) ----
function computeTotals(b = {}) {
  // Normalize
  const isFirst = !!b.isFirstTime;
  let hours = Number(b.hours) || 0;
  if (isFirst && hours < 2) hours = 2;
  if (hours < 2) hours = 2;
  if (hours > 6) hours = 6;

  const mode = String(b.mode || 'ONE_CAMERA').toUpperCase(); // ONE_CAMERA or AUDIO_ONLY
  const baseRate = (mode === 'AUDIO_ONLY') ? 45 : 55; // $/hr

  // Base cameras included: AUDIO_ONLY=0, ONE_CAMERA=1
  const baseIncludedCams = (mode === 'AUDIO_ONLY') ? 0 : 1;

  const extraCameras = Math.max(0, Number(b.extraCameras) || 0);
  const totalCams = baseIncludedCams + extraCameras;

  // Engineer
  const engineerChoice = String(b.engineerChoice || 'any').toLowerCase(); // any|specific|none
  const wantsEngineer = engineerChoice !== 'none';

  // Subtotals
  const baseSubtotal = baseRate * hours;
  const engineerSubtotal = wantsEngineer ? (20 * hours) : 0;

  // Per-session add-ons
  let extrasSession = 0;
  if (extraCameras > 0) extrasSession += extraCameras * 25; // $25 ea (flat / session)
  if (b.remoteGuest)   extrasSession += 10;
  if (b.teleprompter)  extrasSession += 25;
  if (b.adClips5)      extrasSession += 150;
  if (b.mediaSdOrUsb)  extrasSession += 50;

  // Post-production: number of cams to edit (0=none)
  const camsForPost = Math.min(4, Number(b.postProduction) || totalCams);
  const postTier = { 0:0, 1:200, 2:250, 3:300, 4:350 };
  const postProd = postTier[camsForPost] ?? 0;

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

  return {
    breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd },
    total,
    totalCams
  };
}

// ---- Helpers: Stripe promo lookup & discount math ----
async function findPromotionCode(code) {
  if (!stripe || !code) return null;
  const list = await stripe.promotionCodes.list({ code, limit: 1 });
  return list.data[0] || null;
}
function applyDiscount(original, promotion) {
  if (!promotion) return { totalAfter: original, discount: { amount: 0, code: null, promo: null } };
  const coup = promotion.coupon;
  let off = 0;
  if (coup.amount_off) off = coup.amount_off / 100;
  else if (coup.percent_off) off = (original * coup.percent_off) / 100;

  const totalAfter = Math.max(0, Math.round((original - off) * 100) / 100);
  return {
    totalAfter,
    discount: {
      amount: Math.round(off * 100) / 100,
      code: promotion.code,
      promo: promotion.id
    }
  };
}

// ---- Health/diagnostics ----
app.get('/env-check', (req, res) => {
  res.json({
    mode: STRIPE_SECRET ? (STRIPE_SECRET.startsWith('sk_live') ? 'live' : 'test') : 'none',
    hasKey: !!STRIPE_SECRET,
    port: String(process.env.PORT || 5000)
  });
});

// Original quote (no discount)
app.post('/quote', (req, res) => {
  try { res.json(computeTotals(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
});

// Quote WITH Stripe discount preview
app.post('/quote-with-discount', async (req, res) => {
  try {
    const b = req.body || {};
    const base = computeTotals(b);
    let promo = null;
    if (b.couponCode && stripe) {
      promo = await findPromotionCode(String(b.couponCode).trim());
      if (!promo || promo.active === false) promo = null;
    }
    const { totalAfter, discount } = applyDiscount(base.total, promo);
    res.json({ ...base, totalAfter, discount });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Publishable key for on-page payment
app.get('/public-keys', (req, res) => {
  const pub = process.env.STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY_TEST || '';
  res.json({ publishableKey: pub });
});

// Create PaymentIntent for on-page payment (Elements)
app.post('/pay/create-intent', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured.' });
    const b = req.body || {};
    const base = computeTotals(b);

    let promo = null;
    if (b.couponCode) {
      promo = await findPromotionCode(String(b.couponCode).trim());
      if (!promo || promo.active === false) promo = null;
    }
    const { totalAfter } = applyDiscount(base.total, promo);
    const amount = Math.max(0, Math.round(totalAfter * 100));

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        room: b.room || '',
        date: b.date || '',
        startTime: b.startTime || '',
        hours: String(b.hours || 0),
        engineerChoice: b.engineerChoice || '',
        engineerName: b.engineerName || '',
        peopleOnCamera: String(b.peopleOnCamera || 1),
        couponCode: b.couponCode || ''
      }
    });

    res.json({
      clientSecret: intent.client_secret,
      display: { totalAfter, breakdown: base.breakdown, totalCams: base.totalCams }
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Hosted checkout (keeps allow_promotion_codes + applies a specific code if present)
app.post('/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured.' });
    const b = req.body || {};
    const base = computeTotals(b);

    // Build line items (simple single product w/ quantity = hours for studio & engineer)
    const items = [];
    if (base.breakdown.baseSubtotal) {
      items.push({ price_data: { currency:'usd', product_data:{ name:`Studio booking (${b.mode || 'ONE CAMERA'})` }, unit_amount: Math.round(( (String(b.mode||'ONE_CAMERA').toUpperCase()==='AUDIO_ONLY') ? 45 : 55 ) * 100) }, quantity: Math.max(1, Number(b.hours)||1) });
    }
    if (base.breakdown.engineerSubtotal) {
      items.push({ price_data: { currency:'usd', product_data:{ name:'Studio Engineer' }, unit_amount: 2000 }, quantity: Math.max(1, Number(b.hours)||1) });
    }
    if (base.breakdown.extrasSession) {
      items.push({ price_data: { currency:'usd', product_data:{ name:'Extras (session)' }, unit_amount: Math.round(base.breakdown.extrasSession * 100) }, quantity: 1 });
    }
    if (base.breakdown.postProd) {
      items.push({ price_data: { currency:'usd', product_data:{ name:'Post Production' }, unit_amount: Math.round(base.breakdown.postProd * 100) }, quantity: 1 });
    }

    // Promo code (optional)
    let discounts = [];
    if (req.body.couponCode) {
      const promo = await findPromotionCode(String(req.body.couponCode).trim());
      if (promo?.id) discounts = [{ promotion_code: promo.id }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items,
      allow_promotion_codes: true,
      discounts,
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: {
        room: b.room || '',
        date: b.date || '',
        startTime: b.startTime || '',
        hours: String(b.hours || 0),
        engineerChoice: b.engineerChoice || '',
        engineerName: b.engineerName || '',
        peopleOnCamera: String(b.peopleOnCamera || 1),
        couponCode: b.couponCode || ''
      }
    });

    res.json({ checkoutUrl: session.url });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
