// index.js - TurboBot webhook (funnel + Hinglish + no duplicate spam)
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// ----- Env vars -----
const SMARTLINK_WEBHOOK_URL = process.env.SMARTLINK_WEBHOOK_URL;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";

// n8n webhook URLs
// Local dev:  http://localhost:5678/webhook-test/lead-logger
// Production: https://turbothrill-n8n.onrender.com/webhook/lead-logger
const DEFAULT_MAKE_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5678/webhook-test/lead-logger'
    : 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

// Final URL (env > default)
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK_URL;

const N8N_SECRET = process.env.N8N_SECRET || '';

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// unified sendLead using axios (for n8n + Google Sheet)
async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn('MAKE_WEBHOOK_URL not set — skipping forwarding to n8n');
    return;
  }

  try {
    console.log('[sendLead] Sending to n8n URL:', MAKE_WEBHOOK_URL);
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
      },
      timeout: 10000
    });
    console.log('Lead forwarded to n8n');
  } catch (err) {
    console.error(
      'Failed to send lead to n8n:',
      err?.response?.status,
      err?.response?.data || err.message || err
    );
  }
}

// 🔗 Get Smart Link from n8n
async function getSmartLink(phone) {
  if (!SMARTLINK_WEBHOOK_URL) {
    console.warn('SMARTLINK_WEBHOOK_URL not set, using fallback');
    return FLIPKART_LINK;
  }

  try {
    const res = await axios.post(
      SMARTLINK_WEBHOOK_URL,
      {
        phone,
        campaign: 'whatsapp_bot'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
        },
        timeout: 10000
      }
    );

    if (res.data && res.data.smart_link) {
      return res.data.smart_link;
    }

    return FLIPKART_LINK;
  } catch (err) {
    console.error('Smartlink error:', err.message);
    return FLIPKART_LINK;
  }
}
// ----- Defensive global handlers -----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Regex & heuristics -----
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe)/i;

// detect language
function detectLangByScript(text) {
  const HINDI_RE = /[ऀ-ॿ]/;
  const TAMIL_RE = /[\u0B80-\u0BFF]/;
  const TELUGU_RE = /[\u0C00-\u0C7F]/;
  if (!text) return 'en';
  if (HINDI_RE.test(text)) return 'hi';
  if (TAMIL_RE.test(text)) return 'ta';
  if (TELUGU_RE.test(text)) return 'te';
  if (/\b(bhai|bro|demo|kya|ka|kaha|jaldi)\b/i.test(text)) return 'hi'; // Hinglish
  return 'en';
}

// ---- INTENT DETECTION ----
function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();

  // DEMO
  if (t === 'demo' || t.includes('demo') || t.includes('reel') || t.includes('video')) {
    return 'demo';
  }

  // ORDER / BUY / LINK / FLIPKART
  if (
    t === 'order' || t === 'buy' ||
    t.includes('order') || t.includes('buy') ||
    t.includes('flipkart') || t.includes('link')
  ) {
    return 'order';
  }

  // PRICE
  if (
    t === 'price' ||
    t.includes('price') ||
    t.includes('kitna') ||
    t.includes('kitne') ||
    t.includes('cost') ||
    t.includes('rs ') ||
    t.includes('₹')
  ) {
    return 'price';
  }

  // WHAT IS THIS / KYA HAI
  if (
    t.includes('kya hai') ||
    t.includes('kya karta') ||
    t.includes('what is this') ||
    t.includes('ye kya') ||
    t.includes('use kaise') ||
    t.includes('how to use')
  ) {
    return 'what';
  }

  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'help';

  return 'unknown';
}

// ----- FUNNEL MESSAGE SCRIPTS (Step 1–8) -----
const WELCOME_STEP1 = `Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Night rides, reels & group rides ke liye next-level!
Demo chahiye? Bol do DEMO
Buy karna hai? Bol do ORDER`;

const MSG_DEMO = () => (
`🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Real spark metal plate
• Heavy-duty build
• Fits all boots
• Easy install (tape + glue included)
• Long lasting

Price today: ₹441 (COD Available)
Order karne ke liye bol do: ORDER`
);

const MSG_ORDER = () => (
`Bro, Flipkart pe COD & fast delivery mil jayegi 👇
${FLIPKART_LINK}

🔥 Pro tip: Riders usually 2 pieces buy karte hain — dono boots se sparks aur zyada heavy, reel-worthy lagta hai!
⚡ Limited stock
💯 Original Turbo Thrill
🚚 Fast delivery`
);

const MSG_PRICE = `Bro price sirf ₹441 hai Flipkart pe.
COD + fast delivery mil jayegi.
Buy → type ORDER`;

const MSG_WHAT = `Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥
Night rides aur reels ke liye OP effect deta hai 😎

Demo → type DEMO
Order → type ORDER`;

const MSG_SPARK_SAFETY = (lang) => (
  lang === 'hi'
    ? 'Haan bro — sparks sirf visual effect ke liye hain 🔥\nSirf open safe space mein use karo, fuel/logon se door.'
    : 'Yes bro — sparks are just for visual effect 🔥\nUse only in open safe space, away from fuel/people.'
);

// ----- Simple "question" detector (for OpenAI) -----
function looksLikeQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes('?')) return true;
  const qWords = [
    'kya', 'kaise', 'kyu', 'kyun',
    'why', 'what', 'how',
    'safe', 'legal', 'police', 'helmet',
    'return', 'refund', 'replace', 'exchange',
    'fit', 'size', 'original', 'genuine', 'fake'
  ];
  return qWords.some(w => t.includes(w));
}

// ----- Runtime state -----
const processedMessageIds = new Set();
const seenUsers = new Set();

let WHATSAPP_TOKEN_VALID = false;

// token check
async function checkWhatsAppToken() {
  if (!WHATSAPP_TOKEN || !PHONE_ID) {
    console.warn('WhatsApp token or PHONE_ID missing. Skipping token health check.');
    WHATSAPP_TOKEN_VALID = false;
    return;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v16.0/${PHONE_ID}?access_token=${WHATSAPP_TOKEN}`);
    const j = await res.json();
    if (j && j.error) {
      console.error('WhatsApp token invalid/expired (startup):', j.error && j.error.message ? j.error.message : j.error);
      WHATSAPP_TOKEN_VALID = false;
    } else {
      console.log('WhatsApp token OK at startup');
      WHATSAPP_TOKEN_VALID = true;
    }
  } catch (e) {
    console.error('Error checking WhatsApp token at startup:', e && e.message ? e.message : e);
    WHATSAPP_TOKEN_VALID = false;
  }
}
checkWhatsAppToken();

async function sendWhatsAppText(to, text) {
  try {
    if (!WHATSAPP_TOKEN_VALID) {
      console.warn('Skipping WhatsApp send — token invalid or not set.');
      return { skipped: true };
    }
    if (!PHONE_ID) {
      console.warn('PHONE_ID missing. Cannot send WhatsApp message.');
      return { skipped: true };
    }

    const url = `https://graph.facebook.com/v16.0/${PHONE_ID}/messages`;
    const r = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      }),
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const textRes = await r.text();
    console.log('WhatsApp API response:', textRes.slice(0, 1000));

    if (textRes && textRes.includes('Error validating access token')) {
      console.error('WhatsApp token expired/invalid. Please rotate the token.');
      WHATSAPP_TOKEN_VALID = false;
    }

    return textRes;
  } catch (e) {
    console.error('Error sending WhatsApp message:', e && e.stack ? e.stack : e);
    return { error: e };
  }
}

// ----- OpenAI brain with your full training prompt -----
const OPENAI_FALLBACK_REPLY = (FLIPKART_LINK, DEMO_VIDEO_LINK) =>
`Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?\n\n🏁 Price under ₹441 — Limited Stock hai!\n🚀 Flipkart link: ${FLIPKART_LINK}\n⚡ Demo: ${DEMO_VIDEO_LINK}\n\nUse only in open safe space; avoid fuel/people. 😎`;

const tunedSystemPrompt = `
🎯 Goal: Convert every chat into a Flipkart sale using a fun, emotional Hinglish tone (like a cool biker friend).
Never sound like a corporate agent. You’re chill, confident, and reply fast.

🧩 PRODUCT INFO
- Brand: Turbo Thrill
- Product: Turbo Thrill V5 Obsidian Feet Slider (for bikers)
- Material: Special Volcanic Alloy (proprietary)
- Feature: Creates massive sparks when dragged on the road ⚡
- Box Includes: 1 slider, 3M VHB tape, Fevikwik (for mounting)
- Weight: ~60g
- Price: ₹400–₹599 (varies)
- Platform: Flipkart (always give the official Flipkart link)
- Demo Video: ${DEMO_VIDEO_LINK}
- Safety note: "Use only in open safe space; not near flammable areas."

💬 YOUR PERSONALITY
- Language: Hinglish (mix of Hindi + English, chill tone)
- Emotion: Excited, friendly, confident, helpful
- Style: Short sentences. Always 2–4 lines max.
- You call customers "bro", "bhai", or "rider".
- You sprinkle emojis like ⚡🔥😎🏍️ naturally, not too many.
- You reply like a real person, not a bot.

🚦 CONVERSATION RULES
1) Instant Hook for new leads.
2) Detect Intent: price/link/sparks/safety/confused.
3) Create Urgency when user delays.
4) Language: Hindi → Hinglish, English → cool Indian English.
5) Always end with 1 clear CTA.
6) Use short FAQ for sparks, safety, box contents, usage, material, durability.
7) Don't mention logging/Make to user.
8) Forbidden: no fire/explosive instructions, no lifetime promises, no insults.

⭐ FUNNEL STEPS (match these where possible):

STEP 1: WELCOME MESSAGE (first message)
"Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Night rides, reels & group rides ke liye next-level!
Demo chahiye? Bol do DEMO
Buy karna hai? Bol do ORDER"

STEP 2: DEMO RESPONSE (DEMO)
"🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Real spark metal plate
• Heavy-duty build
• Fits all boots
• Easy install (tape + glue included)
• Long lasting

Price today: ₹441 (COD Available)
Order karne ke liye bol do: ORDER"

STEP 3: ORDER RESPONSE (ORDER/BUY/LINK/FLIPKART)
"Bro, Flipkart pe COD & fast delivery mil jayegi 👇
${FLIPKART_LINK}

🔥 Pro tip: Riders usually 2 pieces buy karte hain — dono boots se sparks aur zyada heavy, reel-worthy lagta hai!
⚡ Limited stock
💯 Original Turbo Thrill
🚚 Fast delivery"

STEP 7: PRICE
"Bro price sirf ₹441 hai Flipkart pe.
COD + fast delivery mil jayegi.
Buy → type ORDER"

STEP 8: 'Kya hai / kya karta hai'
"Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥
Night rides aur reels ke liye OP effect deta hai 😎

Demo → type DEMO
Order → type ORDER"
`;

async function callOpenAI(userMessage) {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }

  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'explode', 'detonate', 'arson', 'poison', 'create fire', 'manufacture'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't assist with dangerous or illegal instructions. Please contact support: ${SUPPORT_CONTACT || 'Support'}.`;
    }
  }

  const messages = [
    { role: "system", content: tunedSystemPrompt },
    { role: "user", content: userMessage }
  ];

  const payload = {
    model: OPENAI_MODEL,
    messages,
    max_tokens: Math.min(200, MAX_TOKENS || 120),
    temperature: TEMPERATURE
  };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const j = await resp.json();

    if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
      console.error('OpenAI unexpected response:', JSON.stringify(j).slice(0, 1000));
      return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
    }

    let text = j.choices[0].message.content.trim();

    if (text.split(' ').length > 90) {
      text = text.split(' ').slice(0, 90).join(' ') + '...';
    }

    if (!text) return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
    return text;
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
  }
}

// ===== META CAPI: SEND LEAD EVENT =====
async function sendMetaLeadEvent({ phone, smartToken }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) {
    console.warn('Meta CAPI env vars missing, skipping Meta Lead event');
    return;
  }

  try {
    // 1️⃣ Normalize phone (digits only)
    const normalizedPhone = String(phone || '').replace(/\D/g, '');
    if (!normalizedPhone) return;

    // 2️⃣ SHA256 hash (Meta requirement)
    const hashedPhone = crypto
      .createHash('sha256')
      .update(normalizedPhone)
      .digest('hex');

    // 3️⃣ Build Meta payload
    const payload = {
      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'system_generated',
          event_id: `lead_${smartToken || Date.now()}`,
          user_data: {
            ph: [hashedPhone]
          },
          custom_data: {
            content_name: 'Turbo Thrill V5',
            currency: 'INR',
            value: 0
          }
        }
      ],
      test_event_code: process.env.META_TEST_CODE
    };

    // 4️⃣ Send to Meta
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();
    console.log('Meta Lead Event Sent:', result);
  } catch (err) {
    console.error('Meta CAPI Lead Error:', err.message || err);
  }
}

// ----- Webhook endpoints -----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.status(200).send('OK');
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('incoming body keys:', Object.keys(req.body));
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = (changes && changes.value) ? changes.value : req.body;
    const messages = value.messages || [];
    if (!messages || messages.length === 0) {
      console.log('no messages found in payload');
      return res.sendStatus(200);
    }

    const message = messages[0];
    const msgId = message.id;          // WhatsApp message id
    const from = message.from;
    const text = (message.text && message.text.body) || '';

    // ✅ DUPLICATE PROTECTION BY MESSAGE ID
    if (msgId && processedMessageIds.has(msgId)) {
      console.log(`Message ${msgId} already processed, skipping.`);
      return res.sendStatus(200);
    }
    if (msgId) processedMessageIds.add(msgId);

    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = detectLangByScript(text) || (isHindi ? 'hi' : 'en');
    const lower = (text || '').toLowerCase();
    const intent = detectIntent(text);
    const firstTime = !seenUsers.has(from);

    console.log(`message from ${from} id=${msgId} lang=${userLang} intent=${intent} firstTime=${firstTime} text="${text.slice(0,200)}"`);

    let reply = null;
    let usedIntent = intent;

    // 1) Safety / sparks questions
    if (SAFETY_KEYWORDS.test(lower) && looksLikeQuestion(text)) {
      reply = MSG_SPARK_SAFETY(userLang);
      usedIntent = 'info_sparks';
    }

    // 2) Hard funnel intents
    if (!reply && intent === 'demo') {
      reply = MSG_DEMO();
      usedIntent = 'demo';
    }

    if (!reply && intent === 'order') {
  const smartLink = await getSmartLink(from);

  reply = `Bro, Flipkart pe COD & fast delivery mil jayegi 👇
${smartLink}

🔥 Pro tip: Riders usually 2 pieces buy karte hain — dono boots se sparks aur zyada heavy, reel-worthy lagta hai!
⚡ Limited stock
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

    // 3) STEP 1: Welcome on first message (if no explicit intent overrode it)
    if (!reply && firstTime) {
      reply = WELCOME_STEP1;
      usedIntent = 'welcome_step1';
    }

    // 4) Everything else → let OpenAI handle (so user ALWAYS gets a reply)
    if (!reply) {
      reply = await callOpenAI(text);
      usedIntent = 'openai';
    }

    if (reply && reply.trim()) {
      await sendWhatsAppText(from, reply);
      seenUsers.add(from);
      await sendLead({
        from,
        text,
        aiReply: reply,
        userLang,
        intent: usedIntent,
        messageId: msgId,
        timestamp: new Date().toISOString()
      });
      // 🔥 Send Lead event to Meta CAPI
await sendMetaLeadEvent({
  phone: from,
  smartToken: msgId
});

    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (funnel + Hinglish + no duplicate spam)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
