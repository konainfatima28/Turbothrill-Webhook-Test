// index.js - TurboBot webhook (merged)
require('dotenv').config(); // optional for local .env support; harmless in Render

const express = require('express');
const fetch = require('node-fetch'); // using node-fetch v2 (require-compatible)
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ----- Defensive global handlers (prevent process exit on uncaught errors)
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Environment variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";

// require axios correctly and use env for webhook URL
const axios = require('axios');
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';
// const N8N_SECRET = process.env.N8N_SECRET || '';

// unified sendLead using axios
async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn('MAKE_WEBHOOK_URL not set — skipping forwarding to n8n');
    return;
  }
  try {
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
      },
      timeout: 5000
    });
    console.log('Lead forwarded to n8n');
  } catch (err) {
    console.error('Failed to send lead to n8n:', err?.response?.data || err.message || err);
  }
}

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45"); // slightly more excited tone
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// ----- Small heuristics & regex (merged from user snippet)
const GREETING_REGEX = /^(hi|hello|hey|hii|hola|namaste|yo|salaam|gm|good morning)\b/i;
const PURCHASE_REGEX = /\b(buy|order|bought|purchased|link|book)\b/i;
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe)/i;

// helper: detect language by script / simple hinglish heuristics
function detectLangByScript(text) {
  const HINDI_RE = /[ऀ-ॿ]/;
  const TAMIL_RE = /[\u0B80-\u0BFF]/;
  const TELUGU_RE = /[\u0C00-\u0C7F]/;
  if (!text) return 'en';
  if (HINDI_RE.test(text)) return 'hi';
  if (TAMIL_RE.test(text)) return 'ta';
  if (TELUGU_RE.test(text)) return 'te';
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
⭐ STEP 1: WELCOME MESSAGE

(MUST trigger automatically when user types ANYTHING.)

Hey rider 👋🔥
Ye Turbo Thrill ka THRILL V5 Spark Slider hai!
Boot drag karte hi REAL golden sparks nikalte hain 😎🔥

Night rides, reels & group rides ke liye next-level!
Demo chahiye? Bol do DEMO
Buy karna hai? Bol do ORDER

⭐ STEP 2: DEMO RESPONSE

(When user types DEMO)

🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Real spark metal plate
• Heavy-duty build
• Fits all boots
• Easy install (tape + glue included)
• Long lasting

Price today: ₹498 (COD Available)
Order karne ke liye bol do: ORDER

⭐ STEP 3: ORDER RESPONSE

(When user types ORDER)

Bro, Flipkart pe direct COD & fast delivery mil jayegi 👇
${FLIPKART_LINK}

⚡ Limited stock
⚡ Original Turbo Thrill
⚡ Easy returns
⚡ Fast delivery

⭐ STEP 4: FOLLOW-UP 1 (After 20–30 minutes)

(Best timing for WhatsApp funnels)

Bro demo dekh liya?
Agar spark slider chahiye, aaj Flipkart pe offer chal raha hai 🔥
Order → type ORDER
Price: ₹498 (COD)

⭐ STEP 5: FOLLOW-UP 2 (End of day)

Bro,
Aaj ka Flipkart price kabhi bhi change ho sakta hai ⚡
Agar order karna hai to bol do ORDER
Main link de dunga.

⭐ STEP 6: IF USER ASKS ANYTHING ELSE

This must be handled by fallback logic:

Bro DEMO chahiye to type DEMO
Order karna hai to type ORDER
Main yahi help kar dunga 🔥

⭐ STEP 7: IF USER TYPES PRICE

Bro price sirf ₹498 hai Flipkart pe.
COD + fast delivery mil jayegi.
Buy → type ORDER

⭐ STEP 8: IF USER TYPES “Kya hai / Kya karta hai?”

Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥
Night rides aur reels ke liye OP effect deta hai 😎

Demo → type DEMO
Order → type ORDER
`;

async function callOpenAI(userMessage, userLang = 'en') {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }

  // ... the rest of your existing callOpenAI implementation continues here ...


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
