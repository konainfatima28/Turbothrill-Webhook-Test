// index.js — TurboBot v2.1 (Phase-1: Step-based, Render-safe)
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ================= ENV =================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;

const WEBSITE_LINK = process.env.WEBSITE_LINK || "https://turbothrill.in";
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com";
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "support@turbothrill.in";
const TRACKING_LINK = process.env.TRACKING_LINK || "https://turbo-thrill.shiprocket.co/tracking";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const PORT = process.env.PORT || 3000;

// ================= CONVERSATION STEPS =================
const STEP = {
  IDLE: 'IDLE',
  AWAITING_ORDER_INPUT: 'AWAITING_ORDER_INPUT',
};

// ================= SUPABASE SETUP =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function getUserState(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_users?phone=eq.${phone}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const data = await res.json();
  return data[0] || null;
}

async function upsertUserState(payload) {
  await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_users`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
}

// ================= N8N =================
const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  (process.env.NODE_ENV === 'development'
    ? 'http://localhost:5678/webhook-test/lead-logger'
    : 'https://turbothrill-n8n.onrender.com/webhook/lead-logger');

// ================= STATE =================
const processedMessageIds = new Set(); // duplicate protection

// ================= HELPERS =================
function detectIntent(text = '') {
  const t = text.toLowerCase().trim();

  if (t === 'track') return 'track';
  if (t === 'order') return 'order';
  if (t === 'price') return 'price';
  if (t === 'return') return 'return';
  if (t === 'human') return 'human';
  if (t === 'install') return 'install';
  if (t === 'bulk') return 'bulk';
  if (t === 'demo') return 'demo';

  if (t.includes('track') || t.includes('delivery')) return 'track';
  if (t.includes('price') || t.includes('kitna')) return 'price';
  if (t.includes('order') || t.includes('buy') || t.includes('link')) return 'order';
  if (t.includes('return') || t.includes('refund')) return 'return';
  if (t.includes('install') || t.includes('lagana')) return 'install';
  if (t.includes('bulk') || t.includes('group')) return 'bulk';
  if (t.includes('demo') || t.includes('video')) return 'demo';
  if (t.includes('human') || t.includes('agent')) return 'human';

  return 'unknown';
}

// ================= MESSAGES =================
const WELCOME_MESSAGE = `Hey there, Rider! 🔥

Welcome to Turbo Thrill! I'm here 24/7 to help with:

⚡ Order tracking
🏍️ Product info
📦 Shipping
🔄 Returns
💰 Pricing

Reply with:
TRACK | PRICE | ORDER | HUMAN`;

const MSG_TRACK_REQUEST = `Sure! 📦  
Please share your **order number**  
or **registered phone/email**.`;

const MSG_TRACK_RESPONSE = `Thanks! 📦

Track your order here:
🔗 ${TRACKING_LINK}`;

const MSG_ORDER = `Order directly here 🔥
${WEBSITE_LINK}

Price:
1pc ₹449
2pc ₹849
4pc ₹1,649
6pc ₹2,499
10pc ₹3,999

FREE Shipping | Prepaid only`;

const MSG_PRICE = `Pricing 💰

1pc ₹449
2pc ₹849 ⭐
4pc ₹1,649
6pc ₹2,499
10pc ₹3,999

FREE Shipping
Order → ${WEBSITE_LINK}`;

const MSG_INSTALL = `Installation 🛠️
1. Clean sole
2. Apply slider
3. Press 60 sec
4. Wait 24 hrs

Demo:
${DEMO_VIDEO_LINK}`;

const MSG_BULK = `Bulk packs available 👥
Check:
${WEBSITE_LINK}

For custom qty:
${SUPPORT_CONTACT}`;

const MSG_RETURN = `Returns 🛡️
7-day quality support.

Email:
${SUPPORT_CONTACT}
(with order # + photos)`;

const MSG_DEMO = `Demo video 🔥
${DEMO_VIDEO_LINK}

Order:
${WEBSITE_LINK}`;

const MSG_HUMAN = `Connecting you to support 👤

Hours:
10 AM – 7 PM (Mon–Sat)

Email:
${SUPPORT_CONTACT}`;

const MSG_FALLBACK = `I want to help correctly 🙂  
Type: TRACK | PRICE | ORDER | HUMAN`;

// ================= SENDERS =================
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_ID) return;

  await fetch(`https://graph.facebook.com/v16.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

async function sendLead(data) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    await axios.post(MAKE_WEBHOOK_URL, data, { timeout: 8000 });
  } catch {
    console.error('n8n lead send failed');
  }
}

// ================= WEBHOOK VERIFY =================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================= WEBHOOK HANDLER =================
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;
    const from = message.from;
    const text = message.text?.body || '';

    if (processedMessageIds.has(msgId)) {
      return res.sendStatus(200);
    }
    processedMessageIds.add(msgId);

    const user = await getUserState(from);
    const currentStep = user?.step || STEP.IDLE;

    // ensure user exists
    await upsertUserState({
      phone: from,
      step: currentStep,
      last_seen: new Date().toISOString(),
    });

    // ===== STEP HANDLER =====
    if (currentStep === STEP.AWAITING_ORDER_INPUT) {
      await sendWhatsAppText(from, MSG_TRACK_RESPONSE);

      await upsertUserState({
        phone: from,
        step: STEP.IDLE,
        last_seen: new Date().toISOString(),
      });

      return res.sendStatus(200);
    }

    // ===== INTENT HANDLING =====
    const intent = detectIntent(text);

    if (intent === 'track') {
      await sendWhatsAppText(from, MSG_TRACK_REQUEST);

      await upsertUserState({
        phone: from,
        step: STEP.AWAITING_ORDER_INPUT,
        last_intent: 'track',
        last_seen: new Date().toISOString(),
      });

      return res.sendStatus(200);
    }

    let reply = MSG_FALLBACK;

    if (intent === 'order') reply = MSG_ORDER;
    else if (intent === 'price') reply = MSG_PRICE;
    else if (intent === 'install') reply = MSG_INSTALL;
    else if (intent === 'bulk') reply = MSG_BULK;
    else if (intent === 'return') reply = MSG_RETURN;
    else if (intent === 'demo') reply = MSG_DEMO;
    else if (intent === 'human') reply = MSG_HUMAN;

    await sendWhatsAppText(from, reply);

    await sendLead({
      from,
      text,
      reply,
      intent,
      step: STEP.IDLE,
      timestamp: new Date().toISOString(),
    });

    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    return res.sendStatus(500);
  }
});

// ================= SERVER =================
app.get('/', (_, res) => res.send('TurboBot v2.1 running 🔥'));
app.listen(PORT, () => console.log(`TurboBot running on ${PORT}`));
