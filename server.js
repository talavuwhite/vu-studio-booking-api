// VU Studio Booking API — full drop-in (ESM)
// - Stripe Checkout + webhook -> GHL
// - Pricing rules (Audio Only / One Cam)
// - Bookla-style endpoints: services, availability, short holds
// ----------------------------------------------------------------

import express from "express";
import cors from "cors";
import Stripe from "stripe";

// ------------------- ENV / APP / STRIPE -------------------------------------

const app = express();

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecret ? new Stripe(stripeSecret, { apiVersion: "2024-06-20" }) : null;

const SUCCESS_URL = process.env.SUCCESS_URL || "https://vizionzunlimited.com/bookingsuccess";
const CANCEL_URL  = process.env.CANCEL_URL  || "https://vizionzunlimited.com/bookingcancel";
const PORT        = process.env.PORT || 10000;

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin }));

// ------------------- PRICING -------------------------------------------------

const HOURLY_BASE_ONE_CAM   = 55; // $/hr for camera modes
const HOURLY_BASE_AUDIOONLY = 45; // $/hr for Audio Only
const HOURLY_ENGINEER       = 20; // $/hr unless "None"

const TELEPROMPTER_FEE      = 25;
const REMOTE_GUEST_FEE      = 10;
const AD_CLIPS_5_FEE        = 150;
const MEDIA_SD_USB_FEE      = 50;
const EXTRA_CAMERA_EACH_FEE = 25;

const POST_PROD_FIRST       = 200;
const POST_PROD_EACH_ADDL   = 100;

const MIN_HOURS             = 2;

// ------------------- ENGINEERS / CALENDARS ----------------------------------

const ENGINEERS = {
  "Tala White":     { key: "ENG_PUTALAMUS" },
  "Howard Sanders": { key: "ENG_HOWARD" },
  "Floating":       { key: "ENG_FLOATING" },
  "None":           { key: "" },
};

const ROOM_TO_CAL_ENVKEY = {
  "The Studio":    "CAL_THE_STUDIO",
  "The Lobby":     "CAL_THE_LOBBY",
  "The Box":       "CAL_THE_BOX",
  "The Middle":    "CAL_THE_MIDDLE",
  "The Back Room": "CAL_THE_BACK_ROOM",
};

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

  const baseHourly = mode === "AUDIO_ONLY" ? HOURLY_BASE_AUDIOONLY : HOURLY_BASE_ONE_CAM;
  const baseSubtotal = hours * baseHourly;

  const engineerName     = body.engineer || body.engineerChoice || "Floating";
  const engineerHourly   = engineerName === "None" ? 0 : HOURLY_ENGINEER;
  const engineerSubtotal = hours * engineerHourly;

  const extrasSession =
    (body.teleprompter ? TELEPROMPTER_FEE : 0) +
    (body.remoteGuest ? REMOTE_GUEST_FEE : 0) +
    (body.adClips5 ? AD_CLIPS_5_FEE : 0) +
    (body.mediaSdOrUsb ? MEDIA_SD_USB_FEE : 0) +
    (Math.max(0, num(body.extraCameras, 0)) * EXTRA_CAMERA_EACH_FEE);

  const camsToEdit = Math.max(0, num(body.postProduction, 0));
  const postProdSubtotal = camsToEdit > 0 ? POST_PROD_FIRST + (camsToEdit - 1) * POST_PROD_EACH_ADDL : 0;

  const peopleOnCamera = Math.max(1, num(body.peopleOnCamera, 1));
  const extraCams      = Math.max(0, num(body.extraCameras, 0));
  const totalCams      = Math.max(1, peopleOnCamera, 1 + extraCams);

  const total = baseSubtotal + engineerSubtotal + extrasSession + postProdSubtotal;

  return {
    total, totalCams, hours,
    breakdown: { baseSubtotal, engineerSubtotal, extrasSession, postProd: postProdSubtotal, baseHourly },
    mode, engineer: engineerName,
  };
}

// ------------------- BOOKLA-STYLE MODULE ------------------------------------

// Config
const SLOT_STEP_MIN       = Number(process.env.SLOT_STEP_MIN || 15);
const HOLD_TTL_SECONDS    = Number(process.env.HOLD_TTL_SECONDS || 600); // 10 min
const MIN_LEAD_DAYS       = Number(process.env.MIN_LEAD_DAYS || 3);
const BLOCK_SUNDAYS       = (process.env.BLOCK_SUNDAYS ?? "true") === "true";

const SERVICES = [
  { id: "ONE_CAM", name: "One Camera Session", desc: "2–6 hrs • Engineer optional", minHours: 2, maxHours: 6, start: "10:00", end: "19:00" },
  { id: "AUDIO",   name: "Audio-Only Session",  desc: "2–6 hrs • Engineer optional", minHours: 2, maxHours: 6, start: "10:00", end: "19:00" },
];
const ROOMS = ["The Studio","The Lobby","The Box","The Middle","The Back Room"];

// State (in-memory; move to Redis for multi-instance)
const holds = new Map(); // holdId -> {room,date,startTime,hours,expiresAt}
function purgeExpiredHolds(){ const now=Date.now(); for(const [id,h] of holds){ if(h.expiresAt<=now) holds.delete(id); } }

// Utils
function pad(n){ return (n<10?"0":"")+n; }
function parseHM(hm){ const m=/^(\d{2}):(\d{2})$/.exec(hm); if(!m) return null; const h=+m[1], mm=+m[2]; if(h>23||mm>59) return null; return {h, m:mm}; }
function hmToDateLocal(dateYMD, hm){ const p=parseHM(hm); if(!p) return null; const [y,m,d]=dateYMD.split("-").map(Number); return new Date(y,m-1,d,p.h,p.m,0,0); }
function addMinutes(d, mins){ return new Date(d.getTime()+mins*60000); }
function overlaps(aStart,aEnd,bStart,bEnd){ return aStart < bEnd && bStart < aEnd; }
function isSunday(dateYMD){ const [y,m,d]=dateYMD.split("-").map(Number); return new Date(y,m-1,d).getDay()===0; }
function enforceLeadTime(dateYMD, minDays){
  const today=new Date(); today.setHours(0,0,0,0);
  const [y,m,d]=dateYMD.split("-").map(Number);
  const chosen=new Date(y,m-1,d); chosen.setHours(0,0,0,0);
  return (chosen - today) / 86400000 >= minDays;
}
function getServiceById(id){ return SERVICES.find(s=>s.id===id) || SERVICES[0]; }
function randomId(){ if (typeof globalThis.crypto?.randomUUID==="function") return globalThis.crypto.randomUUID(); return "h_"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); }

// TODO: replace with Google/Outlook calendar fetch for true busy times
async function getBusyIntervals(/*room, dateYMD*/){
  return []; // [{start:"13:00", end:"14:00"}]
}

// Routes (scoped)
const booklaRouter = express.Router();
booklaRouter.use(express.json());

booklaRouter.get("/public/services", (_req,res)=> res.json(SERVICES));

booklaRouter.get("/public/availability", async (req,res)=>{
  purgeExpiredHolds();
  const serviceId = String(req.query.serviceId || SERVICES[0].id);
  const room = String(req.query.room || ROOMS[0]);
  const date = String(req.query.date || "");
  const reqHours = Number(req.query.hours || getServiceById(serviceId).minHours || 2);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error:"Missing/invalid 'date' (YYYY-MM-DD)" });
  if (BLOCK_SUNDAYS && isSunday(date))   return res.json({ slots: [] });
  if (!enforceLeadTime(date, MIN_LEAD_DAYS)) return res.json({ slots: [] });

  const svc = getServiceById(serviceId);
  const blockLenMin = Math.min(Math.max(reqHours*60, svc.minHours*60), svc.maxHours*60);
  const step = SLOT_STEP_MIN;

  const dayStart = hmToDateLocal(date, svc.start);
  const dayEnd   = hmToDateLocal(date, svc.end);
  if (!dayStart || !dayEnd || dayStart >= dayEnd) return res.status(500).json({ error:"Service hours misconfigured" });

  const busy = (await getBusyIntervals(room, date))
    .map(i => ({ start: hmToDateLocal(date,i.start), end: hmToDateLocal(date,i.end) }))
    .filter(i => i.start && i.end && i.start < i.end);

  const activeHolds = [...holds.values()]
    .filter(h => h.room===room && h.date===date)
    .map(h => { const s=hmToDateLocal(date,h.startTime); return { start:s, end:addMinutes(s,h.hours*60) }; });

  const slots = [];
  for (let t=new Date(dayStart); t<=dayEnd; t=addMinutes(t, step)) {
    const start = t;
    const end   = addMinutes(t, blockLenMin);
    if (end > addMinutes(dayEnd, 1)) continue;
    const blocked = busy.some(b=>overlaps(start,end,b.start,b.end)) ||
                    activeHolds.some(h=>overlaps(start,end,h.start,h.end));
    if (!blocked) slots.push(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
  }
  res.json({ slots, stepMin: step, blockLenMin, serviceId, room, date });
});

booklaRouter.post("/public/hold", (req,res)=>{
  purgeExpiredHolds();
  const { room=ROOMS[0], date, startTime, hours=2 } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error:"Missing/invalid 'date'" });
  if (!parseHM(String(startTime))) return res.status(400).json({ error:"Missing/invalid 'startTime' (HH:MM)" });

  const start = hmToDateLocal(date, startTime);
  const end   = addMinutes(start, Number(hours)*60);

  const collide = [...holds.values()].some(h=>{
    if (h.room!==room || h.date!==date) return false;
    const hs = hmToDateLocal(date, h.startTime);
    const he = addMinutes(hs, h.hours*60);
    return overlaps(start,end,hs,he);
  });
  if (collide) return res.status(409).json({ error:"Time is temporarily held. Pick another slot." });

  const holdId = randomId();
  holds.set(holdId, { room, date, startTime, hours:Number(hours), expiresAt: Date.now()+HOLD_TTL_SECONDS*1000 });
  res.json({ holdId, expiresIn: HOLD_TTL_SECONDS });
});

booklaRouter.post("/public/hold/cancel", (req,res)=>{
  const { holdId } = req.body || {};
  if (!holdId || !holds.has(holdId)) return res.status(404).json({ ok:false });
  holds.delete(holdId);
  res.json({ ok:true });
});

// Expose a helper for checkout
function verifyAndConsumeHold({ holdId, room, date, startTime, hours }) {
  purgeExpiredHolds();
  if (!holdId) return { ok: true }; // allow checkout without hold for now
  const h = holds.get(holdId);
  if (!h) return { ok:false, error:"Hold not found or expired." };
  if (h.room!==room || h.date!==date || h.startTime!==startTime || Number(h.hours)!==Number(hours)) {
    return { ok:false, error:"Hold details do not match." };
  }
  holds.delete(holdId);
  return { ok:true };
}

// ------------------- STRIPE WEBHOOK (raw BEFORE json) -----------------------

app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
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

      const engineerNote =
        (m.notes || "") +
        `\n\n[ENGINEER NOTE]\nEngineer: ${engineerName}\nMode: ${m.mode}\n` +
        `PeopleOnCamera: ${num(m.peopleOnCamera,1)}\n` +
        `ExtraCameras: ${num(m.extraCameras,0)}\n` +
        `PostProduction cams: ${num(m.postProduction,0)}`;

      const payloadForWorkflow = {
        name:  m.name || "", email: m.email || "", phone: m.phone || "",
        room, calendarId, sessionDateTimeISO: startISO, endDateTimeISO: endISO, hours,
        engineer: engineerName, engineerValue,
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
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadForWorkflow),
        }).then(r => r.text()).then(txt => console.log("GHL inbound accepted:", txt))
          .catch(err => console.error("GHL inbound error:", err));
      } else {
        console.warn("GHL_INBOUND_URL not set — skipping GHL workflow post.");
      }
    } catch (e) {
      console.error("Webhook processing error:", e);
    }
  }

  res.json({ received: true });
});

// ------------------- JSON FOR EVERYTHING ELSE --------------------------------
app.use(express.json());

// ------------------- ROUTES --------------------------------------------------

app.use(booklaRouter); // mount Bookla-style routes

app.get("/", (_req, res) => res.send("OK"));

app.get("/env-check", (_req, res) => {
  res.json({ mode: envModeFromKey(stripeSecret), hasKey: !!stripeSecret, port: String(PORT) });
});

app.post("/quote", (req, res) => {
  try { res.json(computeQuote(req.body || {})); }
  catch (e) { res.status(400).json({ error: "Bad Request", detail: String(e) }); }
});

app.post("/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
    const b = req.body || {};

    // Verify short hold if one was created
    const check = verifyAndConsumeHold({
      holdId: b.holdId, room: b.room, date: b.date, startTime: b.startTime, hours: b.hours
    });
    if (!check.ok) return res.status(409).json({ error: check.error });

    // Required fields
    for (const f of ["name","email","phone"]) {
      if (!b[f] || String(b[f]).trim()==="") return res.status(400).json({ error:`Missing required field: ${f}` });
    }

    const q = computeQuote(b);

    // Build Stripe line items mirroring the quote
    const items = [];
    items.push({
      price_data: { currency:"usd", product_data:{ name:`Studio booking (${q.mode})` }, unit_amount: Math.round(q.breakdown.baseHourly*100) },
      quantity: q.hours
    });
    if (q.breakdown.engineerSubtotal > 0) {
      items.push({
        price_data: { currency:"usd", product_data:{ name:"Studio Engineer" }, unit_amount: HOURLY_ENGINEER*100 },
        quantity: q.hours
      });
    }
    if (b.teleprompter) items.push({ price_data:{ currency:"usd", product_data:{ name:"Teleprompter" }, unit_amount: TELEPROMPTER_FEE*100 }, quantity:1 });
    if (b.remoteGuest) items.push({ price_data:{ currency:"usd", product_data:{ name:"Remote Guest" }, unit_amount: REMOTE_GUEST_FEE*100 }, quantity:1 });
    if (b.adClips5)   items.push({ price_data:{ currency:"usd", product_data:{ name:"+5 Ad Clips" }, unit_amount: AD_CLIPS_5_FEE*100 }, quantity:1 });
    if (b.mediaSdOrUsb) items.push({ price_data:{ currency:"usd", product_data:{ name:"Media to SD/USB" }, unit_amount: MEDIA_SD_USB_FEE*100 }, quantity:1 });

    const extraCams = Math.max(0, num(b.extraCameras, 0));
    if (extraCams > 0) items.push({ price_data:{ currency:"usd", product_data:{ name:"Extra Camera(s)" }, unit_amount: EXTRA_CAMERA_EACH_FEE*100 }, quantity: extraCams });

    const pp = Math.max(0, num(b.postProduction, 0));
    if (pp > 0) {
      items.push({ price_data:{ currency:"usd", product_data:{ name:"Post Production — first cam" }, unit_amount: POST_PROD_FIRST*100 }, quantity:1 });
      if (pp > 1) items.push({ price_data:{ currency:"usd", product_data:{ name:"Post Production — addl cam(s)" }, unit_amount: POST_PROD_EACH_ADDL*100 }, quantity: pp-1 });
    }

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
