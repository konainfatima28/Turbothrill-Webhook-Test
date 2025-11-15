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
  if (t === 'buy' || t.includes('buy') || t.includes('flipkart') || t.includes('link') || t === 'order' || t.includes('order')) return 'buy';
  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'help';
  if (t.includes('price') || t.includes('₹') || t.includes('rupee') || /\bprice\b/i.test(t)) return 'price';
  if (/\b(kya hai|kya karta|kya hai\?)/i.test(t) || t === 'kya' || t.includes('kya ') ) return 'what_is';
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

// follow-up timers store so we can cancel when user orders
const followUpTimers = new Map();

function scheduleFollowUps(from) {
  // cancel existing
  clearFollowUps(from);

  // Follow-up 1: after ~25 minutes (20-30 min window suggestion)
  const followUp1Delay = 25 * 60 * 1000; // 25 minutes
  const followUp1 = setTimeout(async () => {
    try {
      const msg = `Bro demo dekh liya?\nAgar spark slider chahiye, aaj Flipkart pe offer chal raha hai 🔥\nOrder → type ORDER\nPrice: ₹498 (COD)`;
      await sendWhatsAppText(from, msg);
      await forwardToMake({ from, text: '__followup_1__', aiReply: msg, userLang: 'en', intent: 'followup_1', timestamp: new Date().toISOString() });
    } catch (e) {
      console.error('followUp1 error', e);
    }
  }, followUp1Delay);

  // Follow-up 2: end of day message — schedule to next 23:59 server local time
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 0, 0);
  let followUp2Delay = endOfDay - now;
  if (followUp2Delay <= 0) {
    // if already past 23:59, schedule for next day 23:59
    endOfDay.setDate(endOfDay.getDate() + 1);
    followUp2Delay = endOfDay - now;
  }
  const followUp2 = setTimeout(async () => {
    try {
      const msg = `Bro,\nAaj ka Flipkart price kabhi bhi change ho sakta hai ⚡\nAgar order karna hai to bol do ORDER\nMain link de dunga.`;
      await sendWhatsAppText(from, msg);
      await forwardToMake({ from, text: '__followup_2__', aiReply: msg, userLang: 'en', intent: 'followup_2', timestamp: new Date().toISOString() });
    } catch (e) {
      console.error('followUp2 error', e);
    }
  }, followUp2Delay);

  followUpTimers.set(from, { followUp1, followUp2 });
}

function clearFollowUps(from) {
  const timers = followUpTimers.get(from);
  if (timers) {
    if (timers.followUp1) clearTimeout(timers.followUp1);
    if (timers.followUp2) clearTimeout(timers.followUp2);
    followUpTimers.delete(from);
  }
}

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
 
 Use only in open safe space; avoid fuel/people. 😎
`.trim();

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

    // compute quickIntent and greeting up-front
    const quickIntent = detectIntent(text);
    const isGreeting = GREETING_REGEX.test((text || '').trim());

    // ===== NEW: STEP 1 - WELCOME MESSAGE (must trigger automatically when user types ANYTHING) =====
    // We will compose one single message that always contains the welcome,
    // and if the user's intent is obvious (DEMO/ORDER/PRICE/WHAT_IS) we'll append the intent-specific section
    // so the user receives only one WhatsApp message instead of two.
    const welcomeMsgBase = `Hey rider 👋🔥\nYe Turbo Thrill ka THRILL V5 Spark Slider hai!\nBoot drag karte hi REAL golden sparks nikalte hain 😎🔥\n\nNight rides, reels & group rides ke liye next-level!\nDemo chahiye? Bol do DEMO\nBuy karna hai? Bol do ORDER`;

    // Prepare intent-specific text (only for clear quick intents)
    let intentExtra = '';
    if (quickIntent === 'demo') {
      intentExtra = `🔥 Demo Video:\n${DEMO_VIDEO_LINK}\n\nWhy bikers love it:\n• Real spark metal plate\n• Heavy-duty build\n• Fits all boots\n• Easy install (tape + glue included)\n• Long lasting\n\nPrice today: ₹498 (COD Available)\nOrder karne ke liye bol do: ORDER`;
    } else if (quickIntent === 'buy') {
      intentExtra = `Bro, Flipkart pe direct COD & fast delivery mil jayegi 👇\n${FLIPKART_LINK}\n\n⚡ Limited stock\n⚡ Original Turbo Thrill\n⚡ Easy returns\n⚡ Fast delivery`;
    } else if (quickIntent === 'price') {
      intentExtra = `Bro price sirf ₹498 hai Flipkart pe.\nCOD + fast delivery mil jayegi.\nBuy → type ORDER`;
    } else if (quickIntent === 'what_is') {
      intentExtra = `Bro ye spark slider hai —\nBoot ke neeche laga kar drag karte hi\nREAL golden sparks nikalte hain 🔥\nNight rides aur reels ke liye OP effect deta hai 😎\n\nDemo → type DEMO\nOrder → type ORDER`;
    } else {
      // For unknown / complex messages we still must send welcome alone
      intentExtra = '';
    }

    // Final single payload to send
    const singleReply = intentExtra ? `${welcomeMsgBase}\n\n${intentExtra}` : welcomeMsgBase;

    // Send only one message now
    try {
      await sendWhatsAppText(from, singleReply);
      await forwardToMake({ from, text: '__welcome_combined__', aiReply: singleReply, userLang, intent: quickIntent || 'greeting', timestamp: new Date().toISOString() });
    } catch (e) {
      console.error('welcome_combined send error', e);
    }

    // IMPORTANT FIX: if this incoming message was a greeting (e.g., "hi"), we already sent the welcome.
    // Return early to avoid the separate GREETING_REGEX handler sending a second greeting.
    if (isGreeting) {
      // If intent was demo or buy, still execute follow-up logic before returning
      if (quickIntent === 'demo') {
        scheduleFollowUps(from);
      } else if (quickIntent === 'buy') {
        clearFollowUps(from);
        try { await sendLead({ from, text, intent: 'buy', timestamp: new Date().toISOString() }); } catch(e){ console.error(e); }
      }
      return res.sendStatus(200);
    }
    // ==========================================================================================

    // 1) Greeting short-circuit (from user's snippet) - kept but will not run for messages that were greetings
    if (GREETING_REGEX.test((text || '').trim())) {
      const greet = getGreeting(userLang);
      // we already sent a combined welcome above for ANY message; still send the friendly greeting as well if user said hi explicitly
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
    // (Kept as safety net — we have already handled common quick intents above)
    // -------------------------
    if (quickIntent === 'demo') {
      const demoMsg = `⚡ Riders pagal ho rahe hain iske liye!\nDemo video yahan dekho 👇\n🎥 ${DEMO_VIDEO_LINK}\n\n🔥 Chahiye under ₹498 mein?\nBas reply\u00A0karo\u00A0BUY`;
      await sendWhatsAppText(from, demoMsg);
      await forwardToMake({from, text, aiReply: demoMsg, userLang, intent:'demo', timestamp: new Date().toISOString()});
      scheduleFollowUps(from);
      return res.sendStatus(200);
    }
    if (quickIntent === 'buy') {
      const buyMsg = `🏁 Price under ₹498 — Limited Stock hai!\n🚀 Abhi order karlo Flipkart se 👇\n${FLIPKART_LINK}\n\n💥 Flipkart delivery + easy returns — price badhne\u00A0se\u00A0pehle\u00A0le\u00A0lo`;
      clearFollowUps(from);
      await sendWhatsAppText(from, buyMsg);
      await forwardToMake({from, text, aiReply: buyMsg, userLang, intent:'buy', timestamp: new Date().toISOString()});
      try { await sendLead({ from, text, intent: 'buy', timestamp: new Date().toISOString() }); } catch(e){ console.error(e); }
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

    // If user typed something else that we don't explicitly know, provide fallback (STEP 6)
    // This fallback is short and steers user to DEMO or ORDER
    // We'll only use fallback if text length is short (likely user intent unclear). For longer queries, let OpenAI handle it.
    if (!intent || intent === 'unknown') {
      const shortText = (text || '').trim();
      if (shortText.length <= 80) {
        const fallback = `Bro DEMO chahiye to type DEMO\nOrder karna hai to type ORDER\nMain yahi help kar dunga 🔥`;
        await sendWhatsAppText(from, fallback);
        await forwardToMake({from, text, aiReply: fallback, userLang, intent:'fallback', timestamp: new Date().toISOString()});
        // schedule follow-ups anyway so they get nudged if they don't respond
        scheduleFollowUps(from);
        return res.sendStatus(200);
      }
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

    // Start follow-ups for users who received non-buy replies (avoid scheduling if they ordered)
    if (intent !== 'buy') {
      scheduleFollowUps(from);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (v2 - merged)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
