// index.js - TurboBot webhook (updated flow & templates)
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Defensive global handlers
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// -------- ENV / config
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22";
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';
const N8N_SECRET = process.env.N8N_SECRET || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = Math.min(Number(process.env.MAX_TOKENS || 200), 400);
const TEMPERATURE = Math.min(Math.max(Number(process.env.TEMPERATURE || 0.45), 0), 1.2);
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";

// ---- small heuristics, regex
const GREETING_REGEX = /^(hi|hello|hey|hii|hola|namaste|yo|salaam|gm|good morning)\b/i;

// language detection by unicode script or common hinglish words
function detectLangByScript(text) {
  if (!text) return 'en';
  if (/[ऀ-ॿ]/.test(text)) return 'hi'; // devanagari
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te';
  if (/\b(bhai|bro|demo|kya|ka|kaha|jaldi|order)\b/i.test(text)) return 'hi';
  return 'en';
}

// normalize phone to E.164-like for India (91XXXXXXXXXX)
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/[^\d]/g, '');
  if (s.length === 10) s = '91' + s;
  if (s.length === 11 && s.startsWith('0')) s = '91' + s.slice(1);
  return s;
}

// -------- Message templates based on DEMO / ORDER funnel

function getGreeting(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      'Hey rider 👋🔥\n' +
      'Ye Turbo Thrill ka THRILL V5 Spark Slider hai!\n' +
      'Boot drag karte hi real golden sparks nikalte hain 😎🔥\n\n' +
      'Demo dekhna hai to type: DEMO\n' +
      'Order karna hai to type: ORDER'
    );
  }
  return (
    'Hey rider 👋🔥\n' +
    'This is Turbo Thrill THRILL V5 Spark Slider!\n' +
    'Drag your boot and get real golden sparks 😎🔥\n\n' +
    'To see demo type: DEMO\n' +
    'To order type: ORDER'
  );
}

function demoMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      `⚡ Demo video: ${DEMO_VIDEO_LINK}\n\n` +
      'Riders ko kyu pasand hai:\n' +
      '• Real golden spark effect\n' +
      '• Strong build, long lasting\n' +
      '• Most riding boots pe fit ho jata hai\n' +
      '• Easy install (3M VHB tape + Fevikwik box me hai)\n\n' +
      'Aaj ka price: ₹498 (COD available)\n' +
      'Order karne ke liye type: ORDER\n\n' +
      'Safety: Sirf open safe area me use karo; fuel aur logon se door rakho.'
    );
  }
  return (
    `⚡ Demo video: ${DEMO_VIDEO_LINK}\n\n` +
    'Why riders love it:\n' +
    '• Real golden spark effect\n' +
    '• Heavy-duty, long lasting\n' +
    '• Fits most riding boots\n' +
    '• Easy install (3M VHB tape + glue included)\n\n' +
    'Price today: ₹498 (COD available)\n' +
    'To order type: ORDER\n\n' +
    'Safety: Use only in open safe spaces; keep away from fuel and people.'
  );
}

function orderMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      `🏁 Price: ₹498 — limited stock!\n` +
      `Flipkart se direct order karo (COD available):\n${FLIPKART_LINK}\n\n` +
      'Bas ORDER type karke bola tha — ab link khol ke Flipkart pe place kar do.\n' +
      'Koi dikkat ho to bol: HELP'
    );
  }
  return (
    `🏁 Price: ₹498 — limited stock!\n` +
    `Order directly on Flipkart (COD available):\n${FLIPKART_LINK}\n\n` +
    'You typed ORDER — now just place it on Flipkart.\n' +
    'Need any help? Type: HELP'
  );
}

function followup1Message(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      `Bro, demo dekh liya kya? ⚡\n` +
      `Aaj Flipkart pe price ₹498 hai.\n` +
      `Abhi order karna ho to type: ORDER\n${FLIPKART_LINK}`
    );
  }
  return (
    `Bro, did you watch the demo? ⚡\n` +
    `Today’s Flipkart price is ₹498.\n` +
    `To order now type: ORDER\n${FLIPKART_LINK}`
  );
}

function lastCallMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      'Bro — last reminder ⚡\n' +
      'Flipkart price kabhi bhi change ho sakta hai.\n' +
      `Abhi order karna ho to type: ORDER\n${FLIPKART_LINK}\n` +
      'Stock limited hai.'
    );
  }
  return (
    'Bro — final reminder ⚡\n' +
    'Flipkart price can change anytime.\n' +
    `If you want it, type: ORDER\n${FLIPKART_LINK}\n` +
    'Stock is limited.'
  );
}

function faqHowItWorks(lang) {
  if (lang && lang.startsWith('hi')) {
    return (
      'Ye spark slider boot ke neeche lagta hai —\n' +
      'boot drag karte hi real golden sparks nikalte hain 🔥\n\n' +
      `Demo: ${DEMO_VIDEO_LINK}\n` +
      `Buy (Flipkart): ${FLIPKART_LINK}\n\n` +
      'Use sirf open safe area me karo.'
    );
  }
  return (
    'This spark slider mounts under your boot —\n' +
    'when you drag it, real golden sparks appear 🔥\n\n' +
    `Demo: ${DEMO_VIDEO_LINK}\n` +
    `Buy on Flipkart: ${FLIPKART_LINK}\n\n` +
    'Use only in open safe areas.'
  );
}

function safetyRefusal() {
  return `Sorry, I can't assist with dangerous or illegal instructions. Use only in open safe spaces. Contact: ${SUPPORT_CONTACT}.`;
}

// Fallback reply (keeps it short, DEMO / ORDER focused)
const OPENAI_FALLBACK_REPLY = (flip, demo) =>
  (
    'Bro 👋 Turbo Thrill THRILL V5 Spark Slider hai — boot drag karte hi real golden sparks 😎🔥\n\n' +
    `Demo dekhna hai to type: DEMO (video: ${demo})\n` +
    `Order karna hai to type: ORDER (Flipkart: ${flip})\n\n` +
    'Safety: Sirf open safe area me use karo; fuel aur logon se door rakho.'
  ).trim();

// ----- small dedupe cache to avoid repeated processing within short window
const dedupeCache = new Map();
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS || 45 * 1000);
function shouldSkipDuplicate(from, intent, text) {
  const now = Date.now();
  const entry = dedupeCache.get(from);
  if (!entry) {
    dedupeCache.set(from, { lastIntent: intent, lastText: text, ts: now });
    return false;
  }
  const sameIntent = entry.lastIntent === intent;
  const sameText = entry.lastText === text;
  const withinWindow = now - entry.ts < DEDUPE_WINDOW_MS;
  dedupeCache.set(from, { lastIntent: intent, lastText: text, ts: now });
  return sameIntent && sameText && withinWindow;
}

// clear cache entries periodically to avoid memory growth
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_WINDOW_MS * 4;
  for (const [k, v] of dedupeCache) {
    if (v.ts < cutoff) dedupeCache.delete(k);
  }
}, 60 * 1000);

// ----- WhatsApp token health (non-blocking)
let WHATSAPP_TOKEN_VALID = false;
async function checkWhatsAppToken() {
  if (!WHATSAPP_TOKEN || !PHONE_ID) {
    WHATSAPP_TOKEN_VALID = false;
    return;
  }
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_ID}?access_token=${WHATSAPP_TOKEN}`;
    const r = await axios.get(url, { timeout: 5000 });
    if (r.data && r.data.error) {
      console.error('WhatsApp token invalid/expired:', r.data.error.message || r.data.error);
      WHATSAPP_TOKEN_VALID = false;
    } else {
      WHATSAPP_TOKEN_VALID = true;
    }
  } catch (e) {
    console.warn('WhatsApp token healthcheck failed:', e.message || e);
    WHATSAPP_TOKEN_VALID = false;
  }
}
checkWhatsAppToken();
setInterval(checkWhatsAppToken, 1000 * 60 * 30);

// ----- safe WhatsApp send (returns parsed JSON or object with error/skipped)
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN_VALID) {
    console.warn('Skipping WhatsApp send — token invalid or not set.');
    return { skipped: true };
  }
  if (!PHONE_ID) {
    console.warn('PHONE_ID missing. Cannot send WhatsApp message.');
    return { skipped: true };
  }
  if (!to) {
    console.warn('No "to" number provided.');
    return { skipped: true };
  }

  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_ID}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: String(text).slice(0, 4096) } // cap
    };
    const r = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return r.data;
  } catch (e) {
    const err = (e.response && e.response.data) ? e.response.data : (e.message || e);
    console.error('Error sending WhatsApp:', JSON.stringify(err).slice(0, 1000));
    if (err && err.error && String(err.error.message || '').toLowerCase().includes('access token')) {
      WHATSAPP_TOKEN_VALID = false;
    }
    return { error: err };
  }
}

// ----- OpenAI call (axios)
async function callOpenAI(userMessage, userLang = 'en') {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }
  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'explode', 'detonate', 'arson', 'poison', 'create fire', 'manufacture'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't assist with dangerous or illegal instructions. Please contact support: ${SUPPORT_CONTACT}.`;
    }
  }

  const messages = [
    {
      role: "system",
      content: `
You are TurboBot — a short, rider-friendly, Hinglish-capable sales assistant.
STRICT RULES:
- Max 2–4 short lines.
- Always push the DEMO / ORDER funnel.
- Use these CTAs exactly: "type DEMO" and "type ORDER".
- Focus only on: what it is, demo video, price, Flipkart link, safety.
- Do NOT ask for personal details.
- Do NOT give technical, dangerous or illegal instructions.
If user is confused, reply like:
"Bro DEMO chahiye to type DEMO,
Order ke liye type ORDER."
`
    },
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Demo video: ${DEMO_VIDEO_LINK}\nTo order type: ORDER (Flipkart: ${FLIPKART_LINK})` },
    { role: "user", content: "Order" },
    { role: "assistant", content: `Order directly on Flipkart: ${FLIPKART_LINK}\nPrice: ₹498 (COD available)` },
    { role: "user", content: userMessage }
  ];

  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: OPENAI_MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    }, {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });

    const j = resp.data;
    if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
      console.error('OpenAI unexpected shape:', JSON.stringify(j).slice(0, 1000));
      return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
    }
    let text = j.choices[0].message.content.trim();
    text = text.replace(/\[Watch Demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);
    if (text.split(/\s+/).length > 120) {
      text = text.split(/\s+/).slice(0, 120).join(' ') + '...';
    }
    if (!text) return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
    return text;
  } catch (e) {
    console.error('OpenAI error:', (e.response && e.response.data) ? e.response.data : e.message || e);
    return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
  }
}

// ----- forward to n8n / make (secured if N8N_SECRET provided)
async function forwardToMake(payload = {}) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (N8N_SECRET) headers['x-n8n-secret'] = N8N_SECRET;
    await axios.post(MAKE_WEBHOOK_URL, payload, { headers, timeout: 7000 });
    console.log('Forwarded to n8n/make');
  } catch (e) {
    console.warn('Forward to n8n failed:', e.message || e);
  }
}

// ----- quick intent detector (DEMO / ORDER funnel)
function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();

  if (t === 'demo' || t.includes(' demo') || t.includes('demo video') || t.includes('video')) {
    return 'demo';
  }

  if (
    t === 'order' ||
    t.startsWith('order ') ||
    t.includes(' order ') ||
    t.includes('flipkart') ||
    t.includes('buy')
  ) {
    return 'order';
  }

  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'help';

  if (t.includes('price') || t.includes('₹') || t.includes('rupee') || t.includes('rs ')) {
    return 'price';
  }

  if (t.includes('kya hai') || t.includes('what is') || t.includes('kya karta') || t.includes('how it works')) {
    return 'what_is';
  }

  return 'unknown';
}

// ------ Webhook endpoints

// META verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }
  return res.status(200).send('OK');
});

// POST incoming messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const entry = (body.entry && body.entry[0]) || body;
    const changes = entry && entry.changes && entry.changes[0];
    const value = (changes && changes.value) ? changes.value : entry;
    const messages = (value && value.messages) || [];
    if (!messages.length) {
      console.log('No messages in payload');
      return res.sendStatus(200);
    }

    const message = messages[0];
    const rawFrom = message.from || message.from_phone || message.sender || '';
    const from = normalizePhone(rawFrom);
    const text = (message.text && message.text.body)
      ? String(message.text.body).trim()
      : (message.body || '');
    const userLang = detectLangByScript(text);
    const quickIntent = detectIntent(text);

    console.log(`Incoming msg from=${from} lang=${userLang} text="${(text || '').slice(0, 200)}"`);

    if (!from) {
      console.warn('No sender phone found, ignoring.');
      return res.sendStatus(200);
    }

    // STEP 1: Welcome — any greeting or first message triggers this funnel hook
    if (GREETING_REGEX.test(text || '')) {
      const greet = getGreeting(userLang);
      await sendWhatsAppText(from, greet);
      await forwardToMake({
        from,
        text,
        aiReply: greet,
        userLang,
        intent: 'greeting',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    // Quick FAQ: sparks / safety
    const lower = (text || '').toLowerCase();
    if (/\bspark|sparks\b/.test(lower)) {
      const reply = userLang === 'hi'
        ? 'Haan bro — sparks visual demo effect hain, open area me try karo. Safety: fuel/logon se door rakho.'
        : 'Yes bro — sparks are a visual demo effect. Try only in open areas. Safety: keep away from fuel and people.';
      await sendWhatsAppText(from, reply);
      await forwardToMake({
        from,
        text,
        aiReply: reply,
        userLang,
        intent: 'info_sparks',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    // Quick intent replies — DEMO / ORDER / PRICE / WHAT_IS
    if (quickIntent === 'demo') {
      const demoMsg = demoMessage(userLang);
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({
        from,
        text,
        aiReply: demoMsg,
        userLang,
        intent: 'demo',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    if (quickIntent === 'order' || quickIntent === 'price') {
      const orderMsg = orderMessage(userLang);
      await sendWhatsAppText(from, orderMsg);
      await forwardToMake({
        from,
        text,
        aiReply: orderMsg,
        userLang,
        intent: 'order',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    if (quickIntent === 'what_is') {
      const howMsg = faqHowItWorks(userLang);
      await sendWhatsAppText(from, howMsg);
      await forwardToMake({
        from,
        text,
        aiReply: howMsg,
        userLang,
        intent: 'what_is',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    // dedupe guard
    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate from ${from}`);
      await sendWhatsAppText(from, 'Main ne abhi bheja tha bro — agar message nahi mila to "YES" reply karo.');
      return res.sendStatus(200);
    }

    // If user asks for dangerous instructions, refuse explicitly (safety guard)
    if (/how to .*(explode|detonate|make fire|arson|poison)/i.test(text || '')) {
      const refusal = safetyRefusal();
      await sendWhatsAppText(from, refusal);
      await forwardToMake({
        from,
        text,
        aiReply: refusal,
        userLang,
        intent: 'danger_request',
        timestamp: new Date().toISOString()
      });
      return res.sendStatus(200);
    }

    // Unknown / complex — use OpenAI but keep it funnel-based
    let aiReply = '';
    try {
      aiReply = await callOpenAI(text, userLang);
    } catch (e) {
      console.error('OpenAI call error (caught):', e && e.message ? e.message : e);
      aiReply = '';
    }
    if (!aiReply || !aiReply.trim()) {
      aiReply = OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
    }

    // Ensure order intent always includes Flipkart link
    if ((intent === 'order' || intent === 'price') && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nOrder on Flipkart: ${FLIPKART_LINK}`;
    }

    // send reply & forward to n8n
    const sendRes = await sendWhatsAppText(from, aiReply);
    try {
      await forwardToMake({
        from,
        text,
        aiReply,
        userLang,
        intent,
        timestamp: new Date().toISOString(),
        whatsappResponse: sendRes
      });
    } catch (e) {
      console.warn('Failed to forward to n8n (non-fatal)', e.message || e);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (DEMO / ORDER funnel)'));
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
