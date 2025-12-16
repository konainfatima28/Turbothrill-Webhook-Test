// index.js - TurboBot webhook (funnel + Hinglish + no duplicate spam)
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ----- Env vars -----
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK =
  process.env.FLIPKART_LINK ||
  "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";

const DEFAULT_MAKE_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5678/webhook-test/lead-logger'
    : 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK_URL;
const N8N_SECRET = process.env.N8N_SECRET || '';

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45");
const DEMO_VIDEO_LINK =
  process.env.DEMO_VIDEO_LINK ||
  "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";

const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// ---------- SEND LEAD ----------
async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
      }
    });
  } catch (err) {
    console.error('sendLead failed:', err?.response?.data || err.message);
  }
}

// ---------- SMARTLINK ----------
async function getSmartLink(phone, intent = 'order') {
  try {
    const res = await axios.post(
      process.env.SMARTLINK_WEBHOOK_URL,
      { phone, source: 'whatsapp', intent },
      { timeout: 8000 }
    );
    return res.data?.smart_link || FLIPKART_LINK;
  } catch (e) {
    console.error('Smartlink error:', e.message);
    return FLIPKART_LINK;
  }
}

// ---------- HELPERS ----------
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe)/i;

function detectLangByScript(text) {
  if (!text) return 'en';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/\b(bhai|bro|demo|kya|order|buy)\b/i.test(text)) return 'hi';
  return 'en';
}

function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (t.includes('demo')) return 'demo';
  if (t.includes('order') || t.includes('buy') || t.includes('link')) return 'order';
  if (t.includes('price') || t.includes('₹') || t.includes('kitna')) return 'price';
  if (t.includes('kya') || t.includes('what')) return 'what';
  return 'unknown';
}

// ---------- MESSAGES ----------
const WELCOME_STEP1 = `Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Demo chahiye? DEMO
Buy karna hai? ORDER`;

const MSG_DEMO = () => `🔥 Demo Video:
${DEMO_VIDEO_LINK}

Price today: ₹441 (COD Available)
ORDER likho`;

const MSG_PRICE = `Bro price ₹441 hai.
COD available.
ORDER likho`;

const MSG_WHAT = `Bro ye spark slider hai —
Boot drag karte hi REAL sparks 🔥
Demo → DEMO
Order → ORDER`;

const MSG_SPARK_SAFETY = lang =>
  lang === 'hi'
    ? 'Haan bro — sparks sirf visual effect ke liye 🔥 Safe open area only.'
    : 'Yes bro — sparks are only visual 🔥 Use in open safe area.';

// ---------- STATE ----------
const processedMessageIds = new Set();
const seenUsers = new Set();

// ---------- WEBHOOK ----------
app.post('/webhook', async (req, res) => {
  try {
    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value || req.body;

    const message = value.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;
    if (processedMessageIds.has(msgId)) return res.sendStatus(200);
    processedMessageIds.add(msgId);

    const from = message.from;
    const text = message.text?.body || '';
    const intent = detectIntent(text);
    const firstTime = !seenUsers.has(from);
    const lang = detectLangByScript(text);

    let reply = null;
    let usedIntent = intent;

    if (SAFETY_KEYWORDS.test(text)) {
      reply = MSG_SPARK_SAFETY(lang);
      usedIntent = 'safety';
    }

    if (!reply && intent === 'demo') {
      reply = MSG_DEMO();
      usedIntent = 'demo';
    }

    // ✅ ONLY ONE ORDER BLOCK (SMARTLINK)
    if (!reply && intent === 'order') {
      const smartLink = await getSmartLink(from, 'order');

      reply = `Bro, Flipkart pe COD & fast delivery 👇
${smartLink}

🔥 Limited stock
💯 Original Turbo Thrill
🚚 Fast delivery`;

      usedIntent = 'order';
    }

    if (!reply && intent === 'price') {
      reply = MSG_PRICE;
      usedIntent = 'price';
    }

    if (!reply && intent === 'what') {
      reply = MSG_WHAT;
      usedIntent = 'what';
    }

    if (!reply && firstTime) {
      reply = WELCOME_STEP1;
      usedIntent = 'welcome';
    }

    if (reply) {
      await fetch(`https://graph.facebook.com/v16.0/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: reply }
        })
      });

      seenUsers.add(from);

      await sendLead({
        from,
        text,
        intent: usedIntent,
        timestamp: new Date().toISOString()
      });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`TurboBot running on ${PORT}`));
