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
  if (/\b(bhai|bro|demo|kya|ka|kaha|jaldi)\b/i.test(text)) return 'hi';
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

// -------- Message templates per your updated flow (short & Hinglish-aware)
function getGreeting(lang) {
  if (lang && lang.startsWith('hi')) {
    return `Hey rider 👋🔥\nYe Turbo Thrill V5 hai — riders ko bohot pasand!\nSpecial Volcanic Alloy se bana — road pe slide karte hi epic sparks nikalte hain ⚡\nDemo chahiye ya Flipkart link bheju?`;
  }
  return `Hey rider 👋🔥\nThis is Turbo Thrill V5 — the spark slider riders love!\nMade with our Special Volcanic Alloy — throws epic sparks when slid ⚡\nWant the demo or Flipkart link?`;
}

function demoMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return `⚡ Demo video — dekho: ${DEMO_VIDEO_LINK}\nKyu riders pasand karte hain:\n• Real spark effect (visual)\n• Strong build\n• Fits most boots\n• Easy install (tape + glue included)\nAaj ka price: ₹498 (COD available)\nBuy karne ke liye type: ORDER\nSafety: Sirf open safe area me use karo; fuel ke paas mat karna.`;
  }
  return `⚡ Demo video — watch: ${DEMO_VIDEO_LINK}\nWhy riders love it:\n• Real spark effect (visual)\n• Heavy-duty build\n• Fits most boots\n• Easy install (tape + glue included)\nPrice today: ₹498 (COD available)\nTo buy type: ORDER\nSafety: Use only in open safe spaces; avoid near fuel or people.`;
}

function orderMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return `🏁 Price ₹498 — limited stock!\nOrder Flipkart pe: ${FLIPKART_LINK}\nCOD available • Fast delivery • Easy returns\nOrder me help chahiye? Reply YES`;
  }
  return `🏁 Price ₹498 — limited stock!\nOrder on Flipkart: ${FLIPKART_LINK}\nCOD available • Fast delivery • Easy returns\nNeed help placing order? Reply YES`;
}

function followup1Message(lang) {
  if (lang && lang.startsWith('hi')) {
    return `Bro, demo dekh liya kya? ⚡\nAaj Flipkart pe offer chal raha hai — ₹498.\nOrder karna ho to type ORDER. ${FLIPKART_LINK}`;
  }
  return `Bro, did you watch the demo? ⚡\nOffer live on Flipkart today — ₹498.\nTo order type ORDER. ${FLIPKART_LINK}`;
}

function lastCallMessage(lang) {
  if (lang && lang.startsWith('hi')) {
    return `Bro — last reminder: Flipkart price kabhi bhi change ho sakta hai ⚡\nAbhi order karlo: ${FLIPKART_LINK} — stock limited.\nORDER bol ke bolo.`;
  }
  return `Bro — final reminder: Flipkart price can change anytime ⚡\nGrab it now: ${FLIPKART_LINK} — limited stock.\nReply ORDER to buy.`;
}

function faqHowItWorks(lang) {
  if (lang && lang.startsWith('hi')) {
    return `Ye spark slider boot ke neeche lagta hai — slide karne par visual golden sparks nikalte hain 🔥\nDemo: ${DEMO_VIDEO_LINK} • Buy: ${FLIPKART_LINK}`;
  }
  return `This spark slider sticks under the boot — slide and it shows visual golden sparks 🔥\nDemo: ${DEMO_VIDEO_LINK} • Buy: ${FLIPKART_LINK}`;
}

function safetyRefusal() {
  return `Sorry, I can't assist with dangerous or illegal instructions. Use only in open safe spaces. Contact: ${SUPPORT_CONTACT}.`;
}

// Fallback reply (keeps it short, sales focused)
const OPENAI_FALLBACK_REPLY = (flip, demo) => `
Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?

🏁 Price ₹498 — Limited Stock!
Order on Flipkart: ${flip}

Demo: ${demo}
Use only in open safe spaces; avoid near fuel or people. 😎
`.trim();

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
    { role: "system", content: `
You are TurboBot — short, rider-friendly, Hinglish-capable sales assistant.
Tone: friendly, confident, 2-4 short lines max. Use emojis moderately.
Do NOT provide instructions for dangerous acts. Keep it sales-focused: demo, price, Flipkart link.
` },
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Demo: ${DEMO_VIDEO_LINK}. Reply BUY for Flipkart link.` },
    { role: "user", content: "Buy" },
    { role: "assistant", content: `Grab it on Flipkart: ${FLIPKART_LINK}.` },
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

// ----- quick intent detector
function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();
  if (t === 'demo' || t.includes('demo') || t.includes('video') || t.includes('watch')) return 'demo';
  if (t === 'buy' || t.includes('buy') || t.includes('flipkart') || t.includes('order')) return 'buy';
  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'help';
  if (t.includes('price') || t.includes('₹') || t.includes('rupee')) return 'price';
  if (t.includes('kya hai') || t.includes('what is') || t.includes('kya karta')) return 'what_is';
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
    const text = (message.text && message.text.body) ? String(message.text.body).trim() : (message.body || '');
    const userLang = detectLangByScript(text);
    const quickIntent = detectIntent(text);

    console.log(`Incoming msg from=${from} lang=${userLang} text="${(text||'').slice(0,200)}"`);

    if (!from) {
      console.warn('No sender phone found, ignoring.');
      return res.sendStatus(200);
    }

    // STEP 1: Welcome — any greeting or first message triggers this short hook
    if (GREETING_REGEX.test(text || '')) {
      const greet = getGreeting(userLang);
      await sendWhatsAppText(from, greet);
      await forwardToMake({ from, text, aiReply: greet, userLang, intent: 'greeting', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // Quick FAQ: sparks / safety
    const lower = (text || '').toLowerCase();
    if (/\bspark|sparks\b/.test(lower)) {
      const reply = userLang === 'hi'
        ? 'हाँ bro — sparks visual demo effect हैं, open area में try करो. Safety: fuel/passengers से दूर रखो.'
        : 'Yes bro — sparks are a visual demo effect. Try in open safe areas. Safety: keep away from fuel/people.';
      await sendWhatsAppText(from, reply);
      await forwardToMake({ from, text, aiReply: reply, userLang, intent:'info_sparks', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // Quick intent replies (DEMO / BUY / PRICE) — immediate session messages
    if (quickIntent === 'demo') {
      const demoMsg = demoMessage(userLang);
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({ from, text, aiReply: demoMsg, userLang, intent: 'demo', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    if (quickIntent === 'buy' || quickIntent === 'price') {
      const buyMsg = orderMessage(userLang);
      await sendWhatsAppText(from, buyMsg);
      await forwardToMake({ from, text, aiReply: buyMsg, userLang, intent: 'buy', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    if (quickIntent === 'what_is') {
      const howMsg = faqHowItWorks(userLang);
      await sendWhatsAppText(from, howMsg);
      await forwardToMake({ from, text, aiReply: howMsg, userLang, intent: 'what_is', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // dedupe guard
    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate from ${from}`);
      await sendWhatsAppText(from, "I just sent that — reply YES if you didn't get it.");
      return res.sendStatus(200);
    }

    // call OpenAI for fallback/complex replies (kept short)
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

    // Ensure buy intent includes link
    if (intent === 'buy' && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    // If user asks for dangerous instructions, refuse explicitly (safety)
    if (/how to .*(explode|detonate|make fire|arson|poison)/i.test(text)) {
      await sendWhatsAppText(from, safetyRefusal());
      await forwardToMake({ from, text, aiReply: safetyRefusal(), userLang, intent: 'danger_request', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // send reply & forward to n8n
    const sendRes = await sendWhatsAppText(from, aiReply);
    try {
      await forwardToMake({ from, text, aiReply, userLang, intent, timestamp: new Date().toISOString(), whatsappResponse: sendRes });
    } catch(e) {
      console.warn('Failed to forward to n8n (non-fatal)', e.message || e);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (updated flow)'));
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
