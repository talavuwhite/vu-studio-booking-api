import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

// --- TEMP: debug tap to see the body & computed totals ---
app.post('/quote-debug', (req, res) => {
  try {
    const body = req.body || {};

    // If you have a real calculator function, call it here:
    // const totals = calculateQuote(body);

    // Minimal fallback calculator (so the route always works)
    // Adjust the rates to your real ones if you have them
    const hours = Number(body.hours) || 0;
    const baseRate = 55;            // $55/hr
    const engineerRate = 20;        // $20/hr
    const extraCamRatePerHr = 25;   // $25/hr per extra camera
    const postRate = 150;           // $150/hr of post production

    const extraCameras = Number(body.extraCameras) || 0;
    const postHours = Number(body.postProduction) || 0;

    const baseSubtotal = hours * baseRate;
    const engineerSubtotal = hours * engineerRate;

    const extrasSession =
      (body.remoteGuest ? 10 : 0) +         // example flat fee
      (body.teleprompter ? 50 : 0) +        // example flat fee
      (extraCameras * extraCamRatePerHr * hours);

    const postProd = postHours * postRate;

    const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;
    const totalCams = 1 + extraCameras;

    const totals = {
      breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd },
      total,
      totalCams
    };

    res.json({ received: body, totals });
  } catch (e) {
    console.error('quote-debug error', e);
    res.status(500).json({ error: 'quote-debug failed', message: e?.message });
  }
});

// --- TEMP: diagnostics to verify env on Render ---
app.get('/env-check', (req, res) => {
  res.json({
    mode: process.env.STRIPE_MODE || 'unset',
    hasGenericKey: !!process.env.STRIPE_SECRET_KEY,
    hasTestKey: !!process.env.STRIPE_SECRET_KEY_TEST,
    hasLiveKey: !!process.env.STRIPE_SECRET_KEY_LIVE,
    keyLength:
      (process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || '').length,
    port: process.env.PORT || 5000
  });
});

// Get Stripe secret key from env
const stripeSecretKey = process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.error('❌ Missing Stripe secret key. Set STRIPE_SECRET_KEY_TEST or STRIPE_SECRET_KEY in environment variables.');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

// POST /quote → returns totals from booking.json
app.post('/quote', (req, res) => {
  try {
    const { baseSubtotal = 0, engineerSubtotal = 0, extrasSession = 0, postProd = 0, totalCams = 0 } = req.body;

    const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;

    res.json({
      breakdown: {
        baseSubtotal,
        engineerSubtotal,
        extrasSession,
        postProd
      },
      total,
      totalCams
    });
  } catch (err) {
    console.error('Quote error', err);
    res.status(500).json({ error: 'Quote error' });
  }
});

// POST /checkout → creates Stripe Checkout session
app.post('/checkout', async (req, res) => {
  try {
    const { total } = req.body;

    if (!total || isNaN(total)) {
      return res.status(400).json({ error: 'Invalid total' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Studio Booking'
            },
            unit_amount: Math.round(total * 100) // Convert to cents
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: 'https://your-frontend-site.com/success',
      cancel_url: 'https://your-frontend-site.com/cancel'
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Checkout error', err);
    res.status(500).json({ error: 'Checkout error' });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
