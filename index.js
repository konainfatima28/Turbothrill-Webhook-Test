// index.js - TurboBot webhook (only respond on clear intent/question, no spam)
require('dotenv').config(); // optional for local .env support; harmless in Render

const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ----- Environment variables
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

// ----- Defensive global handlers
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Regex & heuristics
const GREETING_REGEX = /^(hi|hello|hey|hii|hola|namaste|yo|salaam|gm|good morning)\b/i;
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

function getGreeting(lang) {
  const map = {
    en: `Hey rider 👋 Turbo Thrill V5 Spark Slider here!\nType DEMO for video, ORDER for Flipkart link.`,
    hi: `Hey rider 👋 Turbo Thrill V5 Spark Slider hai!\nDemo ke liye DEMO, Flipkart link ke liye ORDER likho.`
  };
  return map[lang] || map.en;
}

// -------- SILENT DEDUPE (no message to user) --------
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

// Only treat something as "user asking" if it’s clearly a question
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

// ----- Fixed funnel messages -----
const MSG_DEMO = (lang) => (
  lang === 'hi'
    ? `⚡ Riders pagal ho rahe hain iske liye!\nDemo video yahan dekho 👇\n🎥 ${DEMO_VIDEO_LINK}\n\n🔥 Chahiye under ₹498 mein?\nBas reply karo ORDER`
    : `⚡ Riders are going crazy for this!\nWatch the demo here 👇\n🎥 ${DEMO_VIDEO_LINK}\n\n🔥 Want it under ₹498?\nJust reply ORDER`
);

const MSG_ORDER = (lang) => (
  lang === 'hi'
    ? `🏁 Price under ₹498 — Limited stock hai!\n🚀 Abhi order karlo Flipkart se 👇\n${FLIPKART_LINK}\n\n💥 Flipkart delivery + easy returns — price badhne se pehle le lo`
    : `🏁 Price under ₹498 — Limited stock!\n🚀 Order now on Flipkart 👇\n${FLIPKART_LINK}\n\n💥 Fast delivery + easy returns — grab it before price increases`
);

const MSG_PRICE = `Bro price sirf ₹498 hai Flipkart pe.\nCOD + fast delivery mil jayegi.\nBuy → type ORDER`;

const MSG_WHAT = `Bro ye spark slider hai —\nBoot ke neeche laga kar drag karte hi\nREAL golden sparks nikalte hain 🔥\n\nNight rides & reels ke liye OP effect 😎\n\nDemo → type DEMO\nOrder → type ORDER`;

const MSG_SPARK_SAFETY = (lang) => (
  lang === 'hi'
    ? 'Haan bro — sparks sirf visual effect ke liye hain 🔥\nSirf open safe space mein use karo, fuel/logon se door.'
    : 'Yes bro — sparks are just for visual effect 🔥\nUse only in open safe space, away from fuel/people.'
);

// ----- Runtime state -----
let WHATSAPP_TOKEN_VALID = false;

// token health check
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

// send WhatsApp
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
        to: to,
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

// ----- OpenAI brain -----
const OPENAI_FALLBACK_REPLY = (FLIPKART_LINK, DEMO_VIDEO_LINK) => 
`Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?\n\n🏁 Price under ₹498 — Limited Stock hai!\n🚀 Flipkart link: ${FLIPKART_LINK}\n⚡ Demo: ${DEMO_VIDEO_LINK}\n\nUse only in open safe space; avoid fuel/people. 😎`;

const tunedSystemPrompt = `
You are Turbo Thrill's WhatsApp assistant for THRILL V5 Spark Slider.

Rules:
- Reply ONLY when user clearly asks something or triggers a command.
- Style: short, Hinglish, casual, biker tone.
- Always keep messages 2–4 lines, no long paragraphs.
- Never ask for personal details.
- Push actions: DEMO (video), ORDER (Flipkart), PRICE, safety, usage, fit, return, etc.
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

  const examples = [
    { role: "user", content: "Ye safe hai kya?" },
    { role: "assistant", content: "Bro ye sirf visual sparks ke liye hai 🔥\nOpen safe space mein use karo, fuel/logon se door.\nDemo chahiye to DEMO likho, order ke liye ORDER." },

    { role: "user", content: "Will it fit on riding boots?" },
    { role: "assistant", content: "Mostly riding boots pe fit ho jata hai bro 👍\nStrap area flat ho to best grip aata hai.\nDemo ke liye DEMO, order ke liye ORDER likho." }
  ];

  const messages = [
    { role: "system", content: tunedSystemPrompt },
    ...examples,
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

    // Trim length
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

// ----- forward to Make -----
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

    // Silent dedupe → avoid spam
    if (shouldSkipDuplicate(from, text)) {
      return res.sendStatus(200);
    }

    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = detectLangByScript(text) || (isHindi ? 'hi' : 'en');

    console.log(`message from ${from} lang=${userLang} text="${text.slice(0,200)}"`);

    const lower = (text || '').toLowerCase();

    // 1) Safety / sparks keywords (user is clearly about sparks/fire)
    if (SAFETY_KEYWORDS.test(lower) && looksLikeQuestion(text)) {
      const reply = MSG_SPARK_SAFETY(userLang);
      await sendWhatsAppText(from, reply);
      await forwardToMake({from, text, aiReply: reply, userLang, intent:'info_sparks', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 2) Greeting → user is initiating → reply once
    if (GREETING_REGEX.test((text || '').trim())) {
      const greet = getGreeting(userLang);
      await sendWhatsAppText(from, greet);
      await forwardToMake({from, text, aiReply: greet, userLang, intent: 'greeting', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 3) Hard funnel intents (commands)
    const intent = detectIntent(text);

    if (intent === 'demo') {
      const demoMsg = MSG_DEMO(userLang);
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({from, text, aiReply: demoMsg, userLang, intent:'demo', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'order') {
      const buyMsg = MSG_ORDER(userLang);
      await sendWhatsAppText(from, buyMsg);
      await forwardToMake({from, text, aiReply: buyMsg, userLang, intent:'order', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'price') {
      await sendWhatsAppText(from, MSG_PRICE);
      await forwardToMake({from, text, aiReply: MSG_PRICE, userLang, intent:'price', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    if (intent === 'what') {
      await sendWhatsAppText(from, MSG_WHAT);
      await forwardToMake({from, text, aiReply: MSG_WHAT, userLang, intent:'what', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 4) For anything else — only reply if it *looks like a question*
    if (!looksLikeQuestion(text)) {
      console.log('Ignoring non-question, non-intent message to avoid spam.');
      return res.sendStatus(200); // NO REPLY
    }

    // 5) Use OpenAI for genuine questions
    let aiReply = await callOpenAI(text, userLang);

    if (!aiReply || !aiReply.trim()) {
      // safer to stay quiet than spam
      console.log('Empty AI reply, not sending anything.');
      return res.sendStatus(200);
    }

    await sendWhatsAppText(from, aiReply);
    await forwardToMake({ from, text, aiReply, userLang, intent:'openai', timestamp: new Date().toISOString() });

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (no spam, only on request)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));  if (TELUGU_RE.test(text)) return 'te';
  if (/\b(bhai|bro|demo|kya|ka|kaha|jaldi)\b/i.test(text)) return 'hi'; // hinglish heuristic
  return 'en';
}

function getGreeting(lang) {
  const map = {
    en: `Hey rider 👋 Have you checked Turbo Thrill V5 yet?\nMade with our Special Volcanic Alloy — throws epic sparks! ⚡\nWant the demo or Flipkart link?`,
    hi: `हे राइडर 👋 क्या आपने Turbo Thrill V5 देखा?\nSpecial Volcanic Alloy से बना है — जब घिसता है तो जबरदस्त स्पार्क्स निकलते हैं! ⚡\nडेमो चाहिए या Flipkart लिंक दूँ?`
  };
  return map[lang] || map.en;
}

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

// ---- DEDUPE CACHE + INTENT DETECTION ----
const dedupeCache = new Map();
const DEDUPE_WINDOW = 45 * 1000; // 45 seconds dedupe window

function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();
  if (t === 'demo' || t.includes('demo') || t.includes('watch') || t.includes('video')) return 'demo';
  if (t === 'buy' || t.includes('buy') || t.includes('flipkart') || t.includes('link')) return 'buy';
  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'help';
  return 'unknown';
}

function shouldSkipDuplicate(from, intent, text) {
  const now = Date.now();
  const entry = dedupeCache.get(from);
  if (!entry) {
    dedupeCache.set(from, { lastIntent: intent, lastText: text, ts: now });
    return false;
  }
  const sameIntent = entry.lastIntent === intent;
  const sameText = entry.lastText === text;
  const withinWindow = now - entry.ts < DEDUPE_WINDOW;
  // update cache timestamp every time
  dedupeCache.set(from, { lastIntent: intent, lastText: text, ts: now });
  return sameIntent && sameText && withinWindow;
}

// ----- Runtime state
let WHATSAPP_TOKEN_VALID = false;

// ----- Helper: check WhatsApp token health (non-blocking)
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
// run check but do not block startup
checkWhatsAppToken();

// ----- Safety-wrapped send to WhatsApp Cloud API
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
        to: to,
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

    // Helpful check to surface token expiration quickly
    if (textRes && textRes.includes('Error validating access token')) {
      console.error('WhatsApp token expired/invalid. Please rotate the token in Meta Developer Console and update Render env var.');
      WHATSAPP_TOKEN_VALID = false;
    }

    return textRes;
  } catch (e) {
    console.error('Error sending WhatsApp message:', e && e.stack ? e.stack : e);
    return { error: e };
  }
}

// ----- Tuned system prompt + language-aware OpenAI call -----
const OPENAI_FALLBACK_REPLY = (FLIPKART_LINK, DEMO_VIDEO_LINK) => 
`Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?\n

 🏁 Price under ₹498 — Limited Stock hai! \n 🚀 Abhi order karlo Flipkart se 👇\n  ${FLIPKART_LINK}\n\n 💥 Flipkart delivery + easy returns — price badhne se pehle le lo\n\n
 
 ⚡ Riders pagal ho rahe hain iske liye!\n Demo video yahan dekho 👇  ${DEMO_VIDEO_LINK} ⚡\n\n 🔥 Chahiye under ₹498 mein? \n Bas reply karo BUY\n\n
 
 Use only in open safe space; avoid fuel/people. 😎\n`.trim();

const tunedSystemPrompt = `
You are TurboBot MAX v2 — the official WhatsApp sales assistant for Turbo Thrill V5 Obsidian Feet Slider.

PURPOSE: Convert ad leads into Flipkart buyers, fast — by creating curiosity, trust and urgency in a friendly biker-Hinglish voice.

VOICE & STYLE (required)
- Tone: cool biker bro (Hinglish-first). Confident, playful, compact.
- Sentences: 1–3 short lines (max 3–4). Use 1 emoji per line max.
- Address the user as "bro", "bhai", or "rider". Use light slang but never rude.
- Always end with **one** clear CTA (Flipkart link / Demo). Never multiple CTAs.

PRODUCT FACTS (use these verbatim when needed)
- Product name: Turbo Thrill V5 Obsidian Feet Slider
- Material label: Special Volcanic Alloy (do NOT disclose composition)
- Unique demo feature: produces MASSIVE SPARKS when dragged on rough road surfaces ⚡ (mention but never instruct unsafe use)
- Box: 1 slider, 3M VHB tape, Fevikwik
- Approx weight: ~60g
- Typical retail reference: ₹498 (use exact only if you verified; else "around ₹498")
- Always prefer the Flipkart link: provided by system environment variable FLIPKART_LINK.

SALES RULES (hard constraints)
1. If user intent = buy / price / link → give link immediately (one-liner) and stop selling. Example: "Price ≈ ₹498 — grab here 👇 ${FLIPKART_LINK}"
2. If user asks "demo" or "show" → send demo link (DEMO_VIDEO_LINK) then follow with link after 8–12s if they don't reply.
3. For simple greetings (hi/hello/namaste) use a **soft friendly greeting** (no hard sell). Example: "Hey rider 👋 Want a 10s demo or direct link?"
4. If user asks about sparks → say truthfully they are visual, used for demos; include safety sentence: "Use only in open safe space; avoid fuel/people."
5. If user asks for composition or to make sparks more extreme → refuse politely and escalate to human: "That's proprietary — I'll connect you with support if needed."
6. If user expresses purchase intent (exact words like "buy", "order", "link", "I'll take") → check for payment/Flipkart link and send it; then mark lead as purchased via logging webhook.
7. Never give instructions that encourage dangerous/illegal acts or ignition instructions.

MULTI-LANGUAGE & PHRASING
- Detect language by script or short heuristics (Hindi Devanagari → reply in Hindi; Roman-Hinglish → Hinglish; else English).
- If user speaks in any Indian language the bot should reply in same language when possible.
- Keep fallback English short and friendly.

CONVERSION TACTICS (how to nudge)
- Use curiosity hook: "Want to see sparks?" or "10s demo shows the sparks" before price push.  
- Use low-friction CTA: "Flipkart link here 👇" (single click).  
- Use scarcity phrasing only when true: "Limited units in this batch" or "Offer valid today".

LOGGING & FLOW
- After every reply, POST to the Make webhook (MAKE_WEBHOOK_URL) with {from, text, aiReply, userLang, intent, timestamp}.
- Set 'intent' to one of: greeting | info | demo | buy | safety | escalate | other.

END: Always be short, friendly and close with CTA. If unsure, ask a short clarifying question (one-line).
`;

async function callOpenAI(userMessage, userLang = 'en') {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }

  // Quick safety filter before calling
  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'explode', 'detonate', 'arson', 'poison', 'create fire', 'manufacture'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't assist with dangerous or illegal instructions. Please contact support: ${SUPPORT_CONTACT || 'Support'}.`;
    }
  }

  // Few-shot examples to shape style + language
  const examples = [
    // English
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Watch demo (10s): ${DEMO_VIDEO_LINK}. Reply BUY for the Flipkart link.` },
    { role: "user", content: "Buy" },
    { role: "assistant", content: `Grab it on Flipkart: ${FLIPKART_LINK}. Want help with order or COD options?` },

    // Hindi (Devanagari)
    { role: "user", content: "डेमो" },
    { role: "assistant", content: `डेमो देखें (10s): ${DEMO_VIDEO_LINK}। खरीदना है तो 'BUY' लिखें।` },

    // Hinglish
    { role: "user", content: "Demo bhai" },
    { role: "assistant", content: `Demo yahan dekho: ${DEMO_VIDEO_LINK} 🔥 Reply BUY for Flipkart link.` }
  ];

  // Build messages array
  const messages = [
    { role: "system", content: tunedSystemPrompt },
    ...examples,
    { role: "user", content: userMessage }
  ];

  const payload = {
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
    messages: messages,
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

    // Post-processing rules:
    // Replace placeholder bracket links if present
    text = text.replace(/\[Watch Demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);
    text = text.replace(/\[watch demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);

    // Trim length (safety)
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

// ----- Webhook endpoints
// GET verification for Meta
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

// POST webhook handler
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
    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = detectLangByScript(text) || (isHindi ? 'hi' : 'en');

    console.log(`message from ${from} lang=${userLang} text="${text.slice(0,200)}"`);

    // 1) Greeting short-circuit (from user's snippet)
    if (GREETING_REGEX.test((text || '').trim())) {
      const greet = getGreeting(userLang);
      await sendWhatsAppText(from, greet);
      await forwardToMake({from, text, aiReply: greet, userLang, intent: 'greeting', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // 2) Quick FAQ match (keywords) - sparks info
    const lower = text.toLowerCase();
    if (/\b(spark|sparks)\b/.test(lower)) {
      const reply = userLang === 'hi' ? 'हाँ bro — sparks visual effect हैं, demo के लिए open space में use करो.' : 'Yes bro — sparks are a visual demo effect. Use only in open safe spaces.';
      await sendWhatsAppText(from, reply);
      await forwardToMake({from, text, aiReply: reply, userLang, intent:'info_sparks', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }

    // -------------------------
    // QUICK INTENT HANDLER FOR DEMO / BUY (REPLACED PURCHASE_REGEX BLOCK)
    // If user asks for demo or buy, send the exact messages requested by the user and stop processing.
    // -------------------------
    const quickIntent = detectIntent(text);
    if (quickIntent === 'demo') {
      const demoMsg = `⚡ Riders pagal ho rahe hain iske liye!\nDemo video yahan dekho 👇\n🎥 ${DEMO_VIDEO_LINK}\n\n🔥 Chahiye under ₹498 mein?\nBas reply\u00A0karo\u00A0BUY`;
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({from, text, aiReply: demoMsg, userLang, intent:'demo', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }
    if (quickIntent === 'buy') {
      const buyMsg = `🏁 Price under ₹498 — Limited Stock hai!\n🚀 Abhi order karlo Flipkart se 👇\n${FLIPKART_LINK}\n\n💥 Flipkart delivery + easy returns — price badhne\u00A0se\u00A0pehle\u00A0le\u00A0lo`;
      await sendWhatsAppText(from, buyMsg);
      await forwardToMake({from, text, aiReply: buyMsg, userLang, intent:'buy', timestamp: new Date().toISOString()});
      return res.sendStatus(200);
    }
    // -------------------------
    // end quick intent handler
    // -------------------------

    // ===== dedupe check - inside async handler (safe to await) =====
    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate ${intent} from ${from}`);
      await sendWhatsAppText(from, "I just sent that — did you get the demo? Reply YES if you didn't.");
      return res.sendStatus(200);
    }

    // generate reply via OpenAI (guarded & language-aware)
    let aiReply = await callOpenAI(text, userLang);

    // If AI didn't produce anything, fallback
    if (!aiReply || !aiReply.trim()) {
      aiReply = `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;
    }

    // If the user intent is BUY but AI didn't include Flipkart link, append it
    if (intent === 'buy' && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    // attempt send (this is guarded inside sendWhatsAppText)
    await sendWhatsAppText(from, aiReply);

    // forward to Make (optional)
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ from, text, aiReply, userLang, intent, timestamp: new Date().toISOString() })
        });
      } catch (e) {
        console.error('Make webhook error', e && e.message ? e.message : e);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (v2 - merged)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
