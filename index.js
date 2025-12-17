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

// n8n webhook URLs
const DEFAULT_MAKE_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5678/webhook-test/lead-logger'
    : 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK_URL;
const SMARTLINK_WEBHOOK_URL = process.env.SMARTLINK_WEBHOOK_URL;

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

// ----- Send lead to n8n -----
async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
      },
      timeout: 10000
    });
  } catch (err) {
    console.error('sendLead failed:', err?.response?.data || err.message);
  }
}

// ----- SMARTLINK FETCHER (NEW) -----
async function getSmartLink(phone, intent = 'order') {
  try {
    const res = await axios.post(
      SMARTLINK_WEBHOOK_URL,
      {
        phone,
        source: 'whatsapp',
        intent
      },
      { timeout: 8000 }
    );
    return res.data?.smart_link || FLIPKART_LINK;
  } catch (e) {
    console.error('Smartlink fetch failed:', e.message);
    return FLIPKART_LINK;
  }
}

// ----- Helpers -----
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe)/i;

function detectLangByScript(text) {
  if (!text) return 'en';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te';
  if (/\b(bhai|bro|demo|kya|jaldi)\b/i.test(text)) return 'hi';
  return 'en';
}

function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (t.includes('demo')) return 'demo';
  if (t.includes('order') || t.includes('buy') || t.includes('link') || t.includes('flipkart')) return 'order';
  if (t.includes('price') || t.includes('kitna') || t.includes('₹')) return 'price';
  if (t.includes('kya') || t.includes('what')) return 'what';
  if (t.includes('help') || t.includes('support')) return 'help';
  return 'unknown';
}

function looksLikeQuestion(text) {
  if (!text) return false;
  return text.includes('?') || /(kya|how|why|safe|legal)/i.test(text);
}

// ----- Funnel Messages -----
const WELCOME_STEP1 = `Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Demo chahiye? Type DEMO
Buy karna hai? Type ORDER`;

const MSG_DEMO = () => `🔥 Demo Video:
${DEMO_VIDEO_LINK}

Price today: ₹428 (COD Available)
Order karne ke liye type karo: ORDER`;

const MSG_PRICE = `Bro price sirf ₹428 hai.
COD + fast delivery.
Buy → type ORDER`;

const MSG_WHAT = `Bro ye Turbo Thrill ka spark slider hai —
Boot ke neeche laga kar drag karte hi REAL sparks nikalte hain 🔥
Demo → DEMO
Order → ORDER`;

const MSG_SPARK_SAFETY = lang =>
  lang === 'hi'
    ? 'Sparks sirf visual effect ke liye hain 🔥 Use in open space only.'
    : 'Sparks are only visual 🔥 Use in open space only.';

// ----- Runtime -----
const processedMessageIds = new Set();
const seenUsers = new Set();

let WHATSAPP_TOKEN_VALID = true;

// ----- WhatsApp Send -----
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v16.0/${PHONE_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
}

// ----- Webhook verify -----
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ----- MAIN WEBHOOK -----
app.post('/webhook', async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
    if (!messages.length) return res.sendStatus(200);

    const msg = messages[0];
    if (processedMessageIds.has(msg.id)) return res.sendStatus(200);
    processedMessageIds.add(msg.id);

    const from = msg.from;
    const text = msg.text?.body || '';
    const intent = detectIntent(text);
    const firstTime = !seenUsers.has(from);
    const lang = detectLangByScript(text);

    let reply;

    // 1) Handle Safety Questions (sparks/fire)
    if (SAFETY_KEYWORDS.test(text) && looksLikeQuestion(text)) {
      reply = MSG_SPARK_SAFETY(lang);
    } 
    // 2) Handle Demo Intent
    else if (intent === 'demo') {
      reply = MSG_DEMO();
    } 
    // 3) Handle Order Intent and generate Smartlink
    else if (intent === 'order') {
      const smartLink = await getSmartLink(from, 'order');
      reply = `Bro, Flipkart pe COD & fast delivery 👇
${smartLink}

🔥 Pro tip: Riders usually 2 pieces buy karte hain — dono boots se sparks aur zyada heavy, reel-worthy lagta hai!
⚡ Limited stock
💯 Original Turbo Thrill
🚚 Fast delivery`;
    } 
    // 4) Handle Price Intent
    else if (intent === 'price') {
      reply = MSG_PRICE;
    } 
    // 5) Handle What Intent
    else if (intent === 'what') {
      reply = MSG_WHAT;
    } 
    // 6) Handle First Time Visitors
    else if (firstTime) {
      reply = WELCOME_STEP1;
    }

    // If no reply, call OpenAI
    if (!reply) reply = await callOpenAI(text);

    await sendWhatsAppText(from, reply);
    seenUsers.add(from);

    await sendLead({
      from,
      text,
      aiReply: reply,
      intent,
      timestamp: new Date().toISOString()
    });

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get('/', (_, res) => res.send('TurboBot running'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
