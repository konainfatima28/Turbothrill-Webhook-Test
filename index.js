// index.js - TurboBot webhook (improved & ready for Render)
require('dotenv').config();

const express = require('express');
const axios = require('axios'); // use axios everywhere for consistency
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
const N8N_SECRET = process.env.N8N_SECRET || ''; // optional header to secure webhook
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
  // if 10 digits -> add 91
  if (s.length === 10) s = '91' + s;
  if (s.length === 11 && s.startsWith('0')) s = '91' + s.slice(1);
  return s;
}

// tuned messages
function getGreeting(lang) {
  if (lang && lang.startsWith('hi')) {
    return `हे राइडर 👋 क्या आपने Turbo Thrill V5 देखा?\nSpecial Volcanic Alloy से बना है — जब घिसता है तो जबरदस्त स्पार्क्स निकलते हैं! ⚡\nडेमो चाहिए या Flipkart लिंक दूँ?`;
  }
  return `Hey rider 👋 Have you checked Turbo Thrill V5 yet?\nMade with our Special Volcanic Alloy — throws epic sparks! ⚡\nWant the demo or Flipkart link?`;
}

const OPENAI_FALLBACK_REPLY = (flip, demo) => `
Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?

🏁 Price under ₹498 — Limited Stock hai!
🚀 Abhi order karlo Flipkart se 👇
${flip}

Demo video: ${demo}
Use only in open safe space; avoid fuel/people. 😎
`.trim();

// ----- small dedupe cache to avoid repeated processing within short window
const dedupeCache = new Map();
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS || 45 * 1000); // 45s default
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
  // update cache
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
setInterval(checkWhatsAppToken, 1000 * 60 * 30); // check every 30m

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
    // if auth error -> mark invalid so future attempts skip
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
  // safety filter
  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'explode', 'detonate', 'arson', 'poison', 'create fire', 'manufacture'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't assist with dangerous or illegal instructions. Please contact support: ${SUPPORT_CONTACT}.`;
    }
  }

  // build prompts with short examples to drive style
  const messages = [
    { role: "system", content: `
You are TurboBot — short, rider-friendly, Hinglish-capable sales assistant.
Tone: friendly, confident, 2-4 short lines max. Use emojis moderately.
Do NOT provide instructions for dangerous acts. Keep it sales-focused: demo, price, Flipkart link.
` },
    // few shot
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Watch demo: ${DEMO_VIDEO_LINK}. Reply BUY for Flipkart link.` },
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

    // small post-processing
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
    // basic structure guard
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
    const intentQuick = detectIntent(text);

    console.log(`Incoming msg from=${from} lang=${userLang} text="${(text||'').slice(0,200)}"`);

    // 0) Basic sanity: drop if no phone or empty
    if (!from) {
      console.warn('No sender phone found, ignoring.');
      return res.sendStatus(200);
    }

    // 1) Greeting short-circuit
    if (GREETING_REGEX.test(text || '')) {
      const greet = getGreeting(userLang);
      await sendWhatsAppText(from, greet);
      await forwardToMake({ from, text, aiReply: greet, userLang, intent: 'greeting', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // 2) keyword quick answers - sparks / safety
    const lower = (text || '').toLowerCase();
    if (/\bspark|sparks\b/.test(lower)) {
      const reply = userLang === 'hi'
        ? 'हाँ bro — sparks visual demo effect हैं, open area में try करो.'
        : 'Yes bro — sparks are a visual demo effect. Use only in open safe areas.';
      await sendWhatsAppText(from, reply);
      await forwardToMake({ from, text, aiReply: reply, userLang, intent:'info_sparks', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // 3) quick intent for demo/buy: respond immediately (keeps session messages free inside 24h window)
    if (intentQuick === 'demo') {
      const demoMsg = `⚡ Riders pagal ho rahe hain iske liye!\nDemo video yahan dekho 👇\n🎥 ${DEMO_VIDEO_LINK}\n\n🔥 Chahiye under ₹498? Bas reply BUY`;
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({ from, text, aiReply: demoMsg, userLang, intent: 'demo', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }
    if (intentQuick === 'buy' || intentQuick === 'price') {
      const buyMsg = `🏁 Price under ₹498 — Limited Stock!\nOrder on Flipkart: ${FLIPKART_LINK}\nCOD available.`;
      await sendWhatsAppText(from, buyMsg);
      await forwardToMake({ from, text, aiReply: buyMsg, userLang, intent: 'buy', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // 4) dedupe guard (avoid rapid duplicates)
    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate from ${from}`);
      await sendWhatsAppText(from, "I just sent that — reply YES if you didn't get it.");
      return res.sendStatus(200);
    }

    // 5) call OpenAI for fallback/complex replies
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

    // ensure buy intent includes link
    if (intent === 'buy' && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    // 6) send reply & forward to n8n
    const sendRes = await sendWhatsAppText(from, aiReply);
    // forward to Make/n8n (best-effort)
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

app.get('/', (req, res) => res.send('TurboBot webhook running (improved)'));
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
