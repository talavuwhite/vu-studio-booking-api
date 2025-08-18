// VU Studio Booking API — clean drop-in (ESM)
// - Stripe Checkout
// - Engineers: Tala White, Howard Sanders, Floating
// - Room master calendars (Render env)
// - Stripe webhook -> GHL inbound webhook
// - Pricing rules incl. Audio Only

import express from "express";
import cors from "cors";
import Stripe from "stripe";

// ------------------- ENV / APP / STRIPE -------------------------------------

const app = express();

// Webhook secret for signature verification
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// CORS (your site or * during dev)
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin,
  })
);

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: "2024-06-20" }) : null;

const SUCCESS_URL = process.env.SUCCESS_URL || "https://vizionzunlimited.com/bookingsuccess";
const CANCEL_URL  = process.env.CANCEL_URL  || "https://vizionzunlimited.com/bookingcancel";
const PORT        = process.env.PORT || 10000;

// ------------------- PRICING -------------------------------------------------
// Mode: AUDIO_ONLY => $45/hr ; otherwise One Camera price $55/hr
const HOURLY_BASE_ONE_CAM   = 55; // $/hr for camera modes
const HOURLY_BASE_AUDIOONLY = 45; // $/hr for Audio Only
const HOURLY_ENGINEER       = 20; // $/hr unless "None"

const TELEPROMPTER_FEE      = 25;   // per session
const REMOTE_GUEST_FEE      = 10;   // per session
const AD_CLIPS_5_FEE        = 150;  // per session
const MEDIA_SD_USB_FEE      = 50;   // per session
const EXTRA_CAMERA_EACH_FEE = 25;   // per session, per extra camera

// Post production: first $200, each additional +$100
const POST_PROD_FIRST       = 200;
const POST_PROD_EACH_ADDL   = 100;

const MIN_HOURS             = 2;

// ------------------- ENGINEERS / CALENDARS ----------------------------------

// Engineers resolved from env — set these to emails (or whatever you use in GHL)
const ENGINEERS = {
  "Tala White":     { key: "ENG_PUTALAMUS" },
  "Howard Sanders": { key: "ENG_HOWARD" },
  "Floating":       { key: "ENG_FLOATING" },
  "None":           { key: "" }, // special "no engineer" case
};

// Room label -> env key that holds the calendar ID
const ROOM_TO_CAL_ENVKEY = {
  "The Studio":    "CAL_THE_STUDIO",
  "The Lobby":     "CAL_THE_LOBBY",
  "The Box":       "CAL_THE_BOX",
  "The Middle":    "CAL_THE_MIDDLE",
  "The Back Room": "CAL_THE_BACK_ROOM",
};

// GHL inbound webhook (Workflow → Inbound Webhook URL)
const GHL_INBOUND_URL = process.env.GHL_INBOUND_URL || "";

// ------------------- HELPERS -------------------------------------------------

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

// Build ISO from separate date/time (both strings)
function toIsoFromDateAndTime(dateStr, timeStr) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  const [hh, mm]  = (timeStr || "10:00").split(":").map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1, hh || 10, mm || 0, 0);
  return dt.toISOString();
}

function getEngineerEnvKey(name) {
  return ENGINEERS[name]?.key || ENGINEERS["Floating"].key;
}
function getEngineerEnvValue(name) {
  const envKey = getEngineerEnvKey(name);
  return envKey ? (process.env[envKey] || name) : name;
}

function getCalendarIdForRoom(room) {
  const envKey = ROOM_TO_CAL_ENVKEY[room] || ROOM_TO_CAL_ENVKEY["The Studio"];
  const id = envKey ? process.env[envKey] : "";
  if (!id) throw new Error(`No calendar configured for room "${room}" (missing ${envKey}).`);
  return id;
}

// Pricing engine
function computeQuote(body = {}) {
  const hours = Math.max(MIN_HOURS, num(body.hours, MIN_HOURS));
  const mode  = (body.mode || "ONE_CAMERA").toUpperCase();

  const baseHourly =
    mode === "AUDIO_ONLY" ? HOURLY_BASE_AUDIOONLY : HOURLY_BASE_ONE_CAM;
  const baseSubtotal = hours * baseHourly;

  const engineerName    = body.engineer || body.engineerChoice || "Floating";
  const engineerHourly  = engineerName === "None" ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0) +
    (Math.max(0, num(body.extraCameras, 0)) * EXTRA_CAMERA_EACH_FEE);

  const camsToEdit = Math.max(0, num(body.postProduction, 0));
  let postProdSubtotal = 0;
  if (camsToEdit > 0) {
    postProdSubtotal = POST_PROD_FIRST + (camsToEdit - 1) * POST_PROD_EACH_ADDL;
  }

  const peopleOnCamera = Math.max(1, num(body.peopleOnCamera, 1));
  const extraCams      = Math.max(0, num(body.extraCameras, 0));
  const totalCams      = Math.max(1, peopleOnCamera, 1 + extraCams);

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
      baseHourly, // handy for line-items
    },
    mode,
    engineer: engineerName,
  };
}

// ------------------- WEBHOOK (raw body FIRST) --------------------------------
// MUST be registered before express.json() so body isn't parsed.
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!stripe) return res.status(500).send("Stripe not configured");
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const m = session.metadata || {};

      try {
        const room        = m.room || "The Studio";
        const calendarId  = getCalendarIdForRoom(room);

        const engineerName  = m.engineer || "Floating";
        const engineerValue = getEngineerEnvValue(engineerName);

        const startISO = toIsoFromDateAndTime(m.date, m.startTime);
        const hours    = Math.max(MIN_HOURS, num(m.hours, MIN_HOURS));
        const endISO   = new Date(new Date(startISO).getTime() + hours * 3600_000).toISOString();

        // Long engineer note (goes into GHL “Notes”)
        const engineerNote =
          (m.notes || "") +
          `\n\n[ENGINEER NOTE]\nEngineer: ${engineerName}\nMode: ${m.mode}\n` +
          `PeopleOnCamera: ${num(m.peopleOnCamera,1)}\n` +
          `ExtraCameras: ${num(m.extraCameras,0)}\n` +
          `PostProduction cams: ${num(m.postProduction,0)}`;

        const payloadForWorkflow = {
          // contact
          name:  m.name || "",
          email: m.email || "",
          phone: m.phone || "",

          // booking
          room,
          calendarId,
          sessionDateTimeISO: startISO,
          endDateTimeISO: endISO,
          hours,

          // engineer
          engineer: engineerName,
          engineerValue, // your workflow can email/SMS this value

          // extras / context
          mode: (m.mode || "ONE_CAMERA").toUpperCase(),
          peopleOnCamera: num(m.peopleOnCamera, 1),
          extraCameras:   num(m.extraCameras, 0),
          remoteGuest:     m.remoteGuest   === "true",
          teleprompter:    m.teleprompter  === "true",
          adClips5:        m.adClips5      === "true",
          mediaSdOrUsb:    m.mediaSdOrUsb  === "true",
          postProduction:  num(m.postProduction, 0),

          total: num(m.total, 0),
          notes: engineerNote,
          stripeSessionId: session.id,
        };

        if (GHL_INBOUND_URL) {
          fetch(GHL_INBOUND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payloadForWorkflow),
          })
            .then(r => r.text())
            .then(txt => console.log("GHL inbound accepted:", txt))
            .catch(err => console.error("GHL inbound error:", err));
        } else {
          console.warn("GHL_INBOUND_URL not set — skipping GHL workflow post.");
        }
      } catch (e) {
        console.error("Webhook processing error:", e);
      }
    }

    res.json({ received: true });
  }
);

// ------------------- JSON FOR EVERYTHING ELSE --------------------------------
app.use(express.json());

// ------------------- ROUTES --------------------------------------------------

app.get("/", (_req, res) => res.send("OK"));

app.get("/env-check", (_req, res) => {
  res.json({
    mode: envModeFromKey(stripeSecret),
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
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    const b = req.body || {};

    // Required fields (you asked for these)
    const required = ["name", "email", "phone"];
    for (const f of required) {
      if (!b[f] || String(b[f]).trim() === "") {
        return res.status(400).json({ error: `Missing required field: ${f}` });
      }
    }

    const q = computeQuote(b);

    // Build Stripe line items from the quote (mirrors your totals)
    const items = [];

    // Base hours (use baseHourly from computeQuote)
    items.push({
      price_data: {
        currency: "usd",
        product_data: { name: `Studio booking (${q.mode})` },
        unit_amount: Math.round(q.breakdown.baseHourly * 100),
      },
      quantity: q.hours,
    });

    // Engineer hours if applicable
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

    // Session add-ons
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

    // Extra cameras ($25 each)
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

    // Post-production: first 200 + 100 addl
    const pp = Math.max(0, num(b.postProduction, 0));
    if (pp > 0) {
      items.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Post Production — first cam" },
          unit_amount: POST_PROD_FIRST * 100,
        },
        quantity: 1,
      });
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

    // Pack metadata for webhook -> GHL
    const engineerName = b.engineer || b.engineerChoice || "Floating";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: items,
      allow_promotion_codes: true,
      success_url: SUCCESS_URL + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: CANCEL_URL,
      metadata: {
        name: String(b.name || ""),
        email: String(b.email || ""),
        phone: String(b.phone || ""),
        room: String(b.room || "The Studio"),
        date: String(b.date || ""),
        startTime: String(b.startTime || ""),
        hours: String(Math.max(MIN_HOURS, num(b.hours, MIN_HOURS))),
        mode: String((b.mode || "ONE_CAMERA").toUpperCase()),
        engineer: String(engineerName),
        peopleOnCamera: String(num(b.peopleOnCamera, 1)),
        extraCameras: String(num(b.extraCameras, 0)),
        remoteGuest: String(!!b.remoteGuest),
        teleprompter: String(!!b.teleprompter),
        adClips5: String(!!b.adClips5),
        mediaSdOrUsb: String(!!b.mediaSdOrUsb),
        postProduction: String(num(b.postProduction, 0)),
        notes: String(b.notes || ""),
        total: String(q.total),
      },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error("checkout error:", err);
    res.status(400).json({ error: "Checkout failed", detail: String(err) });
  }
});

// ------------------- START ---------------------------------------------------

app.listen(PORT, () => {
  console.log(`VU booking API running on :${PORT}`);
});
