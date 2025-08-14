// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import Stripe from 'stripe';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- CORS ----------
app.use(cors());

// ---------- Stripe webhook (must read RAW body; put BEFORE json parser) ----------
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata || {};
    try {
      // Upsert contact
      const contactResp = await axios.post(
        'https://services.leadconnectorhq.com/contacts/',
        {
          locationId: process.env.GHL_LOCATION_ID,
          firstName: (m.customerName || '').split(' ')[0] || 'Guest',
          lastName: (m.customerName || '').split(' ').slice(1).join(' ') || '',
          email: m.customerEmail || '',
          phone: m.customerPhone || '',
          tags: ['Studio Booking', `Room: ${m.room}`]
        },
        { headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' } }
      );
      const contactId = contactResp.data?.contact?.id;

      // Time math
      const startLocal = `${m.date} ${m.startTime}`; // "YYYY-MM-DD HH:mm"
      const startISO = `${m.date}T${m.startTime}:00`;
      const end = new Date(startISO);
      end.setHours(end.getHours() + parseInt(m.hours || '1', 10));
      const endLocal = end.toISOString().slice(0, 16).replace('T', ' ');

      // Engineer
      const ENGINEERS = {
        'Floating Engineer': process.env.ENG_FLOATING || null,
        'Howard Sander': process.env.ENG_HOWARD || null,
        'Putalamus White': process.env.ENG_PUTALAMUS || null
      };
      const engineerId =
        m.engineerChoice === 'specific' ? (ENGINEERS[m.engineerName] || null)
        : m.engineerChoice === 'any' ? 'ANY'
        : null;

      // Rooms
      const ROOMS = {
        'The Lobby': process.env.CAL_THE_LOBBY,
        'The Box': process.env.CAL_THE_BOX,
        'The Studio': process.env.CAL_THE_STUDIO,
        'The Middle': process.env.CAL_THE_MIDDLE,
        'The Back Room': process.env.CAL_THE_BACK_ROOM
      };

      // Create appointment
      const payload = {
        calendarId: ROOMS[m.room],
        title: `Studio Booking — ${m.room}`,
        contactId,
        startTime: startLocal,
        endTime: endLocal,
        appointmentStatus: 'booked',
        notes:
`Mode: ${m.mode}
Engineer: ${m.engineerChoice}${m.engineerName ? ` (${m.engineerName})` : ''}
Extras: extraCameras=${m.extraCameras}, remoteGuest=${m.remoteGuest}, teleprompter=${m.teleprompter}, adClips5=${m.adClips5}, media=${m.mediaSdOrUsb}
TotalCams: ${m.totalCams}
Notes: ${m.notes}`.trim()
      };
      if (engineerId && engineerId !== 'ANY') payload.assignedUserId = engineerId;

      await axios.post(
        'https://services.leadconnectorhq.com/calendars/events',
        payload,
        { headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' } }
      );
    } catch (err) {
      console.error('Failed to create GHL appointment:', err?.response?.data || err.message);
    }
  }
  res.json({ received: true });
});

// ---------- JSON parser for normal routes (AFTER webhook) ----------
app.use(bodyParser.json({ limit: '1mb' }));

// ---------- Pricing helpers ----------
const BASE_RATES = { AUDIO: 45, ONE_CAMERA: 55 };
const ENGINEER_RATE_PER_HOUR = 20;
const ADDON = { EXTRA_CAM_PER_SESSION: 25, REMOTE_GUEST: 10, TELEPROMPTER: 25, AD_CLIPS_5: 150, MEDIA_SD_OR_USB: 50 };
const POST_PROD = { 1: 200, 2: 250, 3: 300, 4: 350 };

const ROOMS = {
  'The Lobby': process.env.CAL_THE_LOBBY,
  'The Box': process.env.CAL_THE_BOX,
  'The Studio': process.env.CAL_THE_STUDIO,
  'The Middle': process.env.CAL_THE_MIDDLE,
  'The Back Room': process.env.CAL_THE_BACK_ROOM
};
const ENGINEERS = {
  'Floating Engineer': process.env.ENG_FLOATING || null,
  'Howard Sander': process.env.ENG_HOWARD || null,
  'Putalamus White': process.env.ENG_PUTALAMUS || null
};

function validateBooking(b) {
  const errs = [];
  if (!b.customer?.name || !b.customer?.email) errs.push('Missing customer name/email.');
  if (!ROOMS[b.room]) errs.push('Invalid room.');
  if (!b.date || !b.startTime) errs.push('Missing date/time.');
  if (!Number.isInteger(b.hours) || b.hours < 1 || b.hours > 6) errs.push('Hours must be 1–6.');
  if (b.isFirstTime && b.hours < 2) errs.push('First booking must be at least 2 hours.');
  if (!['AUDIO', 'ONE_CAMERA'].includes(b.mode)) errs.push('Invalid mode.');
  if (!['specific', 'any', 'none'].includes(b.engineerChoice)) errs.push('Invalid engineer choice.');
  if (b.engineerChoice === 'specific' && !ENGINEERS[b.engineerName]) errs.push('Unknown engineer name.');
  if (b.extraCameras < 0 || b.extraCameras > 3) errs.push('extraCameras must be 0–3.');
  const baseCam = b.mode === 'ONE_CAMERA' ? 1 : 0;
  const totalCams = baseCam + (b.extraCameras || 0);
  if (totalCams < 0 || totalCams > 4) errs.push('Total cameras must be 0–4.');
  return { ok: errs.length === 0, errors: errs };
}

function computePrice(b) {
  const baseRate = b.mode === 'AUDIO' ? BASE_RATES.AUDIO : BASE_RATES.ONE_CAMERA;
  const baseSubtotal = baseRate * b.hours;
  const engineerSubtotal = (b.engineerChoice === 'specific' || b.engineerChoice === 'any') ? ENGINEER_RATE_PER_HOUR * b.hours : 0;
  const baseCam = b.mode === 'ONE_CAMERA' ? 1 : 0;
  const totalCams = baseCam + (b.extraCameras || 0);
  const extrasSession =
      (b.extraCameras || 0) * ADDON.EXTRA_CAM_PER_SESSION
    + (b.remoteGuest ? ADDON.REMOTE_GUEST : 0)
    + (b.teleprompter ? ADDON.TELEPROMPTER : 0)
    + (b.adClips5 ? ADDON.AD_CLIPS_5 : 0)
    + (b.mediaSdOrUsb ? ADDON.MEDIA_SD_OR_USB : 0);
  const postProd = totalCams >= 1 ? POST_PROD[totalCams] : 0;
  const total = baseSubtotal + engineerSubtotal + extrasSession + postProd;
  return { breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd }, total, totalCams };
}

// ---------- Health ----------
app.get('/', (_, res) => res.send('Studio Booking API is running.'));

// ---------- Quote ----------
app.post('/quote', (req, res) => {
  const b = req.body || {};
  const { ok, errors } = validateBooking(b);
  if (!ok) return res.status(400).json({ errors });
  return res.json(computePrice(b));
});

// ---------- Checkout ----------
app.post('/checkout', async (req, res) => {
  try {
    const b = req.body || {};
    const { ok, errors } = validateBooking(b);
    if (!ok) return res.status(400).json({ errors });

    const { breakdown, total, totalCams } = computePrice(b);
    const lineItems = [];
    const baseLabel = b.mode === 'AUDIO'
      ? `Studio Booking (Audio Only) — ${b.hours} hr${b.hours>1?'s':''}`
      : `Studio Booking (1 Camera) — ${b.hours} hr${b.hours>1?'s':''}`;

    lineItems.push({
      price_data: { currency: 'usd', product_data: { name: baseLabel }, unit_amount: (b.mode==='AUDIO'?BASE_RATES.AUDIO:BASE_RATES.ONE_CAMERA)*100 },
      quantity: b.hours
    });
    if (breakdown.engineerSubtotal > 0) {
      lineItems.push({
        price_data: { currency: 'usd', product_data: { name: `Engineer (${b.hours} hr${b.hours>1?'s':''})` }, unit_amount: ENGINEER_RATE_PER_HOUR*100 },
        quantity: b.hours
      });
    }
    if ((b.extraCameras || 0) > 0) {
      lineItems.push({
        price_data: { currency: 'usd', product_data: { name: `Additional Cameras (${b.extraCameras})` }, unit_amount: ADDON.EXTRA_CAM_PER_SESSION*100 },
        quantity: b.extraCameras
      });
    }
    if (b.remoteGuest)  lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Remote Guest' }, unit_amount: ADDON.REMOTE_GUEST*100 }, quantity: 1 });
    if (b.teleprompter) lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Teleprompter' }, unit_amount: ADDON.TELEPROMPTER*100 }, quantity: 1 });
    if (b.adClips5)     lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Advertising Clips (5)' }, unit_amount: ADDON.AD_CLIPS_5*100 }, quantity: 1 });
    if (b.mediaSdOrUsb) lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'SD Card / Flash Drive' }, unit_amount: ADDON.MEDIA_SD_OR_USB*100 }, quantity: 1 });
    if (totalCams >= 1) lineItems.push({ price_data: { currency: 'usd', product_data: { name: `Post-Production (${totalCams} cam${totalCams>1?'s':''})` }, unit_amount: POST_PROD[totalCams]*100 }, quantity: 1 });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: b.customer.email,
      line_items: lineItems,
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      metadata: {
        room: b.room, date: b.date, startTime: b.startTime, hours: String(b.hours),
        mode: b.mode, engineerChoice: b.engineerChoice, engineerName: b.engineerName || '',
        extraCameras: String(b.extraCameras || 0), remoteGuest: String(!!b.remoteGuest),
        teleprompter: String(!!b.teleprompter), adClips5: String(!!b.adClips5), mediaSdOrUsb: String(!!b.mediaSdOrUsb),
        totalCams: String(totalCams), notes: b.notes || '',
        customerName: b.customer?.name || '', customerEmail: b.customer?.email || '', customerPhone: b.customer?.phone || '',
        locationId: process.env.GHL_LOCATION_ID
      }
    });

    return res.json({ checkoutUrl: session.url, total, breakdown });
  } catch (e) {
    console.error('Checkout error', e?.message || e);
    return res.status(500).json({ error: 'Checkout error' });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on ${port}`));
