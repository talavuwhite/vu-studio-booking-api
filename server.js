// VU Studio Booking API — full drop-in (ESM)
// - Stripe Checkout (live/test via STRIPE_SECRET_KEY / STRIPE_MODE)
// - Engineers: Tala White, Howard Sanders, Floating
// - Master calendars by room
// - Webhook -> GHL inbound workflow to create the appointment + notify engineer
// - Quote math matches booking form (see PRICING below)

import express from "express";
import cors from "cors";
import Stripe from "stripe";

// ---------- ENV / CONFIG -----------------------------------------------------

const app = express();

// IMPORTANT: Webhook route must read raw body. Register BEFORE express.json()
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// Allow your website origin or * (dev)
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin,
  })
);

// For all non-webhook routes:
app.use(express.json());

const stripeSecret = process.env.STRIPE_SECRET_KEY || null;
const stripe =
  stripeSecret ? new Stripe(stripeSecret, { apiVersion: "2024-06-20" }) : null;

const SUCCESS_URL =
  process.env.SUCCESS_URL ||
  "https://vizionzunlimited.com/bookingsuccess";
const CANCEL_URL =
  process.env.CANCEL_URL || "https://vizionzunlimited.com/bookingcancel";

const PORT = process.env.PORT || 10000;

// ---------- PRICE TABLE (Studio) ---------------------------------------------
// You asked to keep the studio pricing logic here.
// - Base $55/hr
// - Engineer $20/hr unless “None”
// - Teleprompter $25/session
// - Remote guest $10/session
// - +5 Ad clips $150/session
// - Media to SD/USB $50/session
// - Extra cameras $25 EACH per session
// - Post production: $200 for first cam, +$100 each additional

const HOURLY_BASE_ONE_CAM = 55; // $55/hour
const HOURLY_ENGINEER = 20; // $20/hour when engineer != None
const TELEPROMPTER_FEE = 25;
const REMOTE_GUEST_FEE = 10;
const AD_CLIPS_5_FEE = 150;
const MEDIA_SD_USB_FEE = 50;
const EXTRA_CAMERA_EACH_FEE = 25; // $25 each per session
const POST_PROD_FIRST = 200; // first camera
const POST_PROD_EACH_ADDL = 100; // each additional camera
const MIN_HOURS = 2;

// ---------- ENGINEERS & CALENDARS -------------------------------------------
// Your Render env shows these keys. Map form labels to env keys.
const ENGINEERS = {
  "Tala White": { key: "ENG_PUTALAMUS" },
  "Howard Sanders": { key: "ENG_HOWARD" },
  Floating: { key: "ENG_FLOATING" },
  None: { key: "" }, // special case -> no engineer charge
};

// Room -> Calendar env keys (values hold actual GHL calendar IDs)
const ROOM_TO_CALVAR = {
  "The Studio": "CAL_THE_STUDIO",
  "The Lobby": "CAL_THE_LOBBY",
  "The Box": "CAL_THE_BOX",
  "The Middle": "CAL_THE_MIDDLE",
  "The Back Room": "CAL_THE_BACK_ROOM",
};

// Optional: GHL direct API (not required if using workflow)
const GHL_API_KEY = process.env.GHL_API_KEY || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// Recommended path: Workflow inbound webhook (Automation → Inbound Webhook)
const GHL_INBOUND_URL = process.env.GHL_INBOUND_URL || "";

// ---------- HELPERS ----------------------------------------------------------

function envModeFromKey(key) {
  if (!key) return "none";
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return "unknown";
}
function num(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

// dateStr: "YYYY-MM-DD", timeStr: "HH:mm"
function toIsoFromDateAndTime(dateStr, timeStr) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  const [hh, mm] = (timeStr || "10:00").split(":").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 10, mm || 0, 0);
  return dt.toISOString();
}

function getEngineerEnvKey(name) {
  return ENGINEERS[name]?.key || ENGINEERS["Floating"].key;
}
function getEngineerEnvValue(name) {
  const envKey = getEngineerEnvKey(name);
  return envKey ? process.env[envKey] || name : name;
}
function getCalendarIdForRoom(room) {
  const k = ROOM_TO_CALVAR[room] || ROOM_TO_CALVAR["The Studio"];
  return process.env[k] || "";
}

// Studio pricing engine
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, num(body.hours, MIN_HOURS));
  const mode = body.mode || "ONE_CAMERA";

  // Base
  const baseSubtotal = hours * HOURLY_BASE_ONE_CAM;

  // Engineer hourly unless "None"
  const engName =
    body.engineer || body.engineerChoice || "Floating"; // form may send either
  const engineerHourly = engName === "None" ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  // Extras per session
  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0) +
    // extra cameras $25 each
    (Math.max(0, num(body.extraCameras, 0)) * EXTRA_CAMERA_EACH_FEE);

  // Post production: $200 first + $100 each additional (0 => $0)
  const camsToEdit = Math.max(0, num(body.postProduction, 0));
  let postProdSubtotal = 0;
  if (camsToEdit > 0) {
    postProdSubtotal = POST_PROD_FIRST + (camsToEdit - 1) * POST_PROD_EACH_ADDL;
  }

  // Cameras (FYI)
  const peopleOnCamera = Math.max(1, num(body.peopleOnCamera, 1));
  const extraCams = Math.max(0, num(body.extraCameras, 0));
  const totalCams = Math.max(1, peopleOnCamera, 1 + extraCams);

  const total =
    baseSubtotal + engineerSubtotal + extrasSession + postProdSubtotal;

  return {
    total,
    totalCams,
    hours,
    breakdown: {
      baseSubtotal,
      engineerSubtotal,
      extrasSession,
      postProd: postProdSubtotal,
    },
    mode,
    engineer: engName,
  };
}

// ---------- ROUTES -----------------------------------------------------------

app.get("/", (_req, res) => res.send("OK"));

app.get("/env-check", (_req, res) => {
  res.json({
    mode: envModeFromKey(stripeSecret || ""),
    hasKey: !!stripeSecret,
    port: String(PORT),
  });
});

app.post("/quote", (req, res) => {
  try {
    const q = computeQuote(req.body || {});
    res.json(q);
  } catch (e) {
    res.status(400).json({ error: "Bad Request", detail: String(e) });
  }
});

app.post("/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

    const b = req.body || {};
    const q = computeQuote(b);

    // Build Stripe line items from quote (mirrors pricing)
    const items = [];

    // Base booking (hours)
    items.push({
      price_data: {
        currency: "usd",
        product_data: { name: `Studio booking (${q.mode})` },
        unit_amount: HOURLY_BASE_ONE_CAM * 100,
      },
      quantity: q.hours,
    });

    // Engineer time, if charged
    if (q.breakdown.engineerSubtotal > 0) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Studio Engineer" },
          unit_amount: HOURLY_ENGINEER * 100,
        },
        quantity: q.hours,
      });
    }

    // Teleprompter
    if (b.teleprompter) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Teleprompter" },
          unit_amount: TELEPROMPTER_FEE * 100,
        },
        quantity: 1,
      });
    }
    // Remote guest
    if (b.remoteGuest) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Remote Guest" },
          unit_amount: REMOTE_GUEST_FEE * 100,
        },
        quantity: 1,
      });
    }
    // Ad clips
    if (b.adClips5) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "+5 Ad Clips" },
          unit_amount: AD_CLIPS_5_FEE * 100,
        },
        quantity: 1,
      });
    }
    // Media to SD/USB
    if (b.mediaSdOrUsb) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Media to SD/USB" },
          unit_amount: MEDIA_SD_USB_FEE * 100,
        },
        quantity: 1,
      });
    }
    // Extra cameras — $25 each
    const extraCams = Math.max(0, num(b.extraCameras, 0));
    if (extraCams > 0) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Extra Camera(s)" },
          unit_amount: EXTRA_CAMERA_EACH_FEE * 100,
        },
        quantity: extraCams,
      });
    }

    // Post production: first $200 + $100 addl
    const pp = Math.max(0, num(b.postProduction, 0));
    if (pp > 0) {
      // first cam
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Post Production — first cam" },
          unit_amount: POST_PROD_FIRST * 100,
        },
        quantity: 1,
      });
      // additional cams
      if (pp > 1) {
        items.push({
          price_data: {
            currency: "usd",
            product_data: { name: "Post Production — addl cam(s)" },
            unit_amount: POST_PROD_EACH_ADDL * 100,
          },
          quantity: pp - 1,
        });
      }
    }

    // Build metadata for webhook -> GHL
    const engineerName = b.engineer || b.engineerChoice || "Floating";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: items,
      allow_promotion_codes: true,
      success_url: SUCCESS_URL + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: CANCEL_URL,
      metadata: {
        name: (b.name || "").toString(),
        email: (b.email || "").toString(),
        phone: (b.phone || "").toString(),
        room: (b.room || "The Studio").toString(),
        date: (b.date || "").toString(),
        startTime: (b.startTime || "").toString(),
        hours: String(Math.max(MIN_HOURS, num(b.hours, MIN_HOURS))),
        mode: (b.mode || "ONE_CAMERA").toString(),
        engineer: engineerName.toString(),
        peopleOnCamera: String(num(b.peopleOnCamera, 1)),
        extraCameras: String(num(b.extraCameras, 0)),
        remoteGuest: String(!!b.remoteGuest),
        teleprompter: String(!!b.teleprompter),
        adClips5: String(!!b.adClips5),
        mediaSdOrUsb: String(!!b.mediaSdOrUsb),
        postProduction: String(num(b.postProduction, 0)),
        notes: (b.notes || "").toString(),
        total: String(q.total),
      },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error("checkout error:", err);
    res.status(400).json({ error: "Checkout failed", detail: String(err) });
  }
});

// ---------- STRIPE WEBHOOK -> GHL WORKFLOW ----------------------------------
// Register a raw parser for this route (must be BEFORE app.json() normally).
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!stripe) {
      return res.status(500).send("Stripe not configured");
    }
    let event;
    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const m = session.metadata || {};

      const room = m.room || "The Studio";
      const calendarId = getCalendarIdForRoom(room);

      const engineerName = m.engineer || "Floating";
      const engineerValue = getEngineerEnvValue(engineerName);

      const startISO = toIsoFromDateAndTime(m.date, m.startTime);
      const hours = Math.max(MIN_HOURS, num(m.hours, MIN_HOURS));
      const endISO = new Date(
        new Date(startISO).getTime() + hours * 60 * 60 * 1000
      ).toISOString();

      const engineerNote =
        (m.notes || "") +
        `\n\n[ENGINEER NOTE]\nEngineer: ${engineerName}\nMode: ${
          m.mode
        }\nCamsToEdit: ${num(m.postProduction, 0)}\nExtraCams: ${num(
          m.extraCameras,
          0
        )}`;

      const payloadForWorkflow = {
        // Contact
        name: m.name || "",
        email: m.email || "",
        phone: m.phone || "",

        // Booking
        room,
        calendarId, // your workflow can choose the calendar with this
        sessionDateTimeISO: startISO,
        endDateTimeISO: endISO,
        hours,

        // Engineer
        engineer: engineerName,
        engineerValue, // if ENG_* envs hold emails/IDs, use this in the workflow

        // Extras/context
        mode: m.mode || "ONE_CAMERA",
        peopleOnCamera: num(m.peopleOnCamera, 1),
        extraCameras: num(m.extraCameras, 0),
        remoteGuest: m.remoteGuest === "true",
        teleprompter: m.teleprompter === "true",
        adClips5: m.adClips5 === "true",
        mediaSdOrUsb: m.mediaSdOrUsb === "true",
        postProduction: num(m.postProduction, 0),

        total: num(m.total, 0),
        notes: engineerNote,
        stripeSessionId: session.id,
      };

      if (GHL_INBOUND_URL) {
        // Post to your GHL Workflow inbound webhook
        fetch(GHL_INBOUND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadForWorkflow),
        })
          .then((r) => r.text())
          .then((txt) => console.log("GHL workflow accepted:", txt))
          .catch((err) => console.error("GHL workflow post error:", err));
      } else {
        console.warn(
          "No GHL_INBOUND_URL set — skipping GHL workflow post (booking not created automatically)."
        );
      }
    }

    res.json({ received: true });
  }
);

// ---------- START ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
