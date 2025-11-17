// index.js - TurboBot webhook (funnel steps + Hinglish prompt + no spam)
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
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// ----- Defensive global handlers -----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Regex & heuristics -----
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe)/i;

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

// -------- SILENT DEDUPE (no visible message) --------
const dedupeCache = new Map();
const DEDUPE_WINDOW = 45 * 1000; // 45 seconds

function shouldSkipDuplicate(from, text) {
  if (!from || !text) return false;
  const now = Date.now();
  const entry = dedupeCache.get(from);
  if (!entry) {
    dedupeCache.set(from, { text, ts: now });
    return false;
  }
  const sameText = entry.text === text;
  const withinWindow = now - entry.ts < DEDUPE_WINDOW;
  dedupeCache.set(from, { text, ts: now });
  if (sameText && withinWindow) {
    console.log(`Silent dedupe: skipping repeat from ${from}`);
    return true;
  }
  return false;
}
// ----------------------------------------------------

// Track if we've already sent Step 1 welcome to this user
const seenUsers = new Set();

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

// Treat as question only when it really looks like one
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

// ----- FUNNEL MESSAGE SCRIPTS (Step 1–8) -----
const WELCOME_STEP1 = `Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Night rides, reels & group rides ke liye next-level!
Demo chahiye? Bol do DEMO
Buy karna hai? Bol do ORDER`;

const MSG_DEMO = (lang) => (
  // Step 2 script (with real link)
  `🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Real spark metal plate
• Heavy-duty build
• Fits all boots
• Easy install (tape + glue included)
• Long lasting

Price today: ₹498 (COD Available)
Order karne ke liye bol do: ORDER`
);

const MSG_ORDER = (lang) => (
  // Step 3 script (with real link)
  `Bro, Flipkart pe direct COD & fast delivery mil jayegi 👇
${FLIPKART_LINK}

⚡ Limited stock
⚡ Original Turbo Thrill
⚡ Easy returns
⚡ Fast delivery`
);

// Step 4 & 5: follow-ups (for n8n / Make to use if you want timed flows)
const FOLLOWUP_1_MSG = `Bro demo dekh liya?
Agar spark slider chahiye, aaj Flipkart pe offer chal raha hai 🔥
Order → type ORDER
Price: ₹498 (COD)`;

const FOLLOWUP_2_MSG = `Bro,
Aaj ka Flipkart price kabhi bhi change ho sakta hai ⚡
Agar order karna hai to bol do ORDER
Main link de dunga.`;

// Step 7: Price
const MSG_PRICE = `Bro price sirf ₹498 hai Flipkart pe.
COD + fast delivery mil jayegi.
Buy → type ORDER`;

// Step 8: "Kya hai / kya karta hai?"
const MSG_WHAT = `Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥
Night rides aur reels ke liye OP effect deta hai 😎

Demo → type DEMO
Order → type ORDER`;

// Sparks safety (used when they ask about sparks/fire)
const MSG_SPARK_SAFETY = (lang) => (
  lang === 'hi'
    ? 'Haan bro — sparks sirf visual effect ke liye hain 🔥\nSirf open safe space mein use karo, fuel/logon se door.'
    : 'Yes bro — sparks are just for visual effect 🔥\nUse only in open safe space, away from fuel/people.'
);

// ----- Runtime state -----
let WHATSAPP_TOKEN_VALID = false;

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

// ----- OpenAI brain with your full prompt -----
const OPENAI_FALLBACK_REPLY = (FLIPKART_LINK, DEMO_VIDEO_LINK) =>
`Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?\n\n🏁 Price under ₹498 — Limited Stock hai!\n🚀 Flipkart link: ${FLIPKART_LINK}\n⚡ Demo: ${DEMO_VIDEO_LINK}\n\nUse only in open safe space; avoid fuel/people. 😎`;

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
- Price: ₹498–₹599 (varies)
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
1) Instant Hook:
   When a new lead messages, greet and hook:
   "Yo bro! 👋 Turbo Thrill V5 dekha kya? Ye bana hai Special Volcanic Alloy se — jab road pe ghishta hai toh massive sparks nikalta hai ⚡😎
   Demo chahiye ya Flipkart link bheju?"

2) Detect Intent:
   - If user asks price / link / where to buy → Give Flipkart link instantly.
   - If user asks about sparks → explain they are real sparks but just for thrill, with safety note.
   - If user asks about safety → reassure: safe in open area, not near petrol or flammable stuff.
   - If user is confused → offer demo video.

3) Create Urgency:
   If user delays or says "later", push:
   "Arre bro, ye ₹498 wala offer aaj raat tak hi hai Flipkart pe 😱
   Baad me price jump kar jata hai!"

4) Language Handling:
   - Hindi → reply in Hinglish.
   - English → reply in cool Indian English.

5) Emotional Close:
   Always end with one CTA:
   - "Check link bro 👇 ${FLIPKART_LINK}"
   - "Order kar le bhai, stock jaldi khatam hota hai 🔥"

6) FAQ Handling:
   Use short instant answers:
   - Sparks: real sparks, visual thrill.
   - Safety: use in open space, away from fuel/people.
   - Box: 1 slider + 3M VHB tape + Fevikwik.
   - How to use: stick under shoe, press 60 sec, ready.
   - Material: Special Volcanic Alloy.
   - Durability: depends on use; lasts many rides in normal use.

7) Behavior Tracking:
   All chats are logged externally; don't mention logging to user.

8) Forbidden:
   - Never mention making fire/explosives or illegal use.
   - Never promise lifetime durability.
   - Never insult or argue.

⭐ FUNNEL STEPS (match these when responding):

STEP 1: WELCOME MESSAGE (for new lead)
"Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Night rides, reels & group rides ke liye next-level!
Demo chahiye? Bol do DEMO
Buy karna hai? Bol do ORDER"

STEP 2: DEMO RESPONSE (when user types DEMO)
Send:
"🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Real spark metal plate
• Heavy-duty build
• Fits all boots
• Easy install (tape + glue included)
• Long lasting

Price today: ₹498 (COD Available)
Order karne ke liye bol do: ORDER"

STEP 3: ORDER RESPONSE (when user types ORDER/BUY/LINK/FLIPKART)
Send:
"Bro, Flipkart pe direct COD & fast delivery mil jayegi 👇
${FLIPKART_LINK}

⚡ Limited stock
⚡ Original Turbo Thrill
⚡ Easy returns
⚡ Fast delivery"

STEP 4: FOLLOW-UP 1 (20–30 minutes after demo)
"Bro demo dekh liya?
Agar spark slider chahiye, aaj Flipkart pe offer chal raha hai 🔥
Order → type ORDER
Price: ₹498 (COD)"

STEP 5: FOLLOW-UP 2 (end of day)
"Bro,
Aaj ka Flipkart price kabhi bhi change ho sakta hai ⚡
Agar order karna hai to bol do ORDER
Main link de dunga."

STEP 6: IF USER ASKS ANYTHING ELSE
Fallback reminder:
"Bro DEMO chahiye to type DEMO
Order karna hai to type ORDER
Main yahi help kar dunga 🔥"

STEP 7: IF USER TYPES PRICE
"Bro price sirf ₹498 hai Flipkart pe.
COD + fast delivery mil jayegi.
Buy → type ORDER"

STEP 8: IF USER TYPES "Kya hai / Kya karta hai?"
"Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥
Night rides aur reels ke liye OP effect deta hai 😎

Demo → type DEMO
Order → type ORDER"
`;

async function callOpenAI(userMessage, userLang = 'en') {
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

// ----- forward to Make / logging -----
async function forwardToMake(payload) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
  } catch(e){ console.error('Make forward error', e); }
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
    const from = message.from;
    const text = (message.text && message.text.body) || '';

    if (shouldSkipDuplicate(from, text)) {
      return res.sendStatus(200);
    }

    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = detectLangByScript(text) || (isHindi ? 'hi' : 'en');
    const lower = (text || '').toLowerCase();
    const intent = detectIntent(text);
    const firstTime = !seenUsers.has(from);

    console.log(`message from ${from} lang=${userLang} intent=${intent} firstTime=${firstTime} text="${text.slice(0,200)}"`);

    // 1) Sparks / safety questions
    if (SAFETY_KEYWORDS.test(lower) && looksLikeQuestion(text)) {
      const reply = MSG_SPARK_SAFETY(userLang);
      await sendWhatsAppText(from, reply);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: reply, userLang, intent:'info_sparks', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 2) Hard funnel intents: DEMO / ORDER / PRICE / WHAT
    if (intent === 'demo') {
      const demoMsg = MSG_DEMO(userLang);
      await sendWhatsAppText(from, demoMsg);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: demoMsg, userLang, intent:'demo', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'order') {
      const orderMsg = MSG_ORDER(userLang);
      await sendWhatsAppText(from, orderMsg);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: orderMsg, userLang, intent:'order', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'price') {
      await sendWhatsAppText(from, MSG_PRICE);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: MSG_PRICE, userLang, intent:'price', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'what') {
      await sendWhatsAppText(from, MSG_WHAT);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: MSG_WHAT, userLang, intent:'what', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 3) STEP 1: Welcome for new users (any first message)
    if (firstTime) {
      const welcome = WELCOME_STEP1;
      await sendWhatsAppText(from, welcome);
      seenUsers.add(from);
      await forwardToMake({from, text, aiReply: welcome, userLang, intent:'welcome_step1', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 4) For everything else → only answer if it looks like a real question
    if (!looksLikeQuestion(text)) {
      console.log('Ignoring non-question, non-intent message to avoid spam.');
      return res.sendStatus(200); // no reply
    }

    // 5) Use OpenAI for genuine questions
    let aiReply = await callOpenAI(text, userLang);

    if (!aiReply || !aiReply.trim()) {
      console.log('Empty AI reply, not sending anything.');
      return res.sendStatus(200);
    }

    await sendWhatsAppText(from, aiReply);
    seenUsers.add(from);
    await forwardToMake({ from, text, aiReply, userLang, intent:'openai', timestamp: new Date().toISOString() });

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (funnel + Hinglish + no spam)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
