// index.js - TurboBot webhook (clean, single-send flow)
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // node-fetch v2 compatible
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ----- Defensive global handlers
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Env
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

// ----- Regex, heuristics
const GREETING_REGEX = /^(hi|hello|hey|hii|hola|namaste|yo|salaam|gm|good morning)\b/i;
const SPARKS_KEYWORD = /\b(spark|sparks)\b/i;
const DEDUPE_WINDOW = 45 * 1000; // 45s

// ----- State
let WHATSAPP_TOKEN_VALID = false;
const dedupeCache = new Map();
const followUpTimers = new Map(); // map of from -> { followUp1, followUp2 }

// ----- Helper functions
async function forwardToMake(payload) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Make forward error', e && e.message ? e.message : e);
  }
}

async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn('MAKE_WEBHOOK_URL not set — skipping forwarding to n8n');
    return;
  }
  try {
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    console.log('Lead forwarded to n8n');
  } catch (err) {
    console.error('Failed to send lead to n8n:', err?.response?.data || err.message || err);
  }
}

function detectLangByScript(text) {
  const HINDI_RE = /[ऀ-ॿ]/;
  const TAMIL_RE = /[\u0B80-\u0BFF]/;
  const TELUGU_RE = /[\u0C00-\u0C7F]/;
  if (!text) return 'en';
  if (HINDI_RE.test(text)) return 'hi';
  if (TAMIL_RE.test(text)) return 'ta';
  if (TELUGU_RE.test(text)) return 'te';
  if (/\b(bhai|bro|demo|kya|ka|kaha|jaldi)\b/i.test(text)) return 'hi';
  return 'en';
}

function getGreeting(lang) {
  const map = {
    en: `Hey rider 👋 Have you checked Turbo Thrill V5 yet?\nMade with our Special Volcanic Alloy — throws epic sparks! ⚡\nWant the demo or Flipkart link?`,
    hi: `हे राइडर 👋 क्या आपने Turbo Thrill V5 देखा?\nSpecial Volcanic Alloy से बना है — जब घिसता है तो जबरदस्त स्पार्क्स निकलते हैं! ⚡\nडेमो चाहिए या Flipkart लिंक दूँ?`
  };
  return map[lang] || map.en;
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
  // update cache timestamp every time we see a message
  dedupeCache.set(from, { lastIntent: intent, lastText: text, ts: now });
  return sameIntent && sameText && withinWindow;
}

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
      WHATSAPP_TOKEN_VALID = true;
      console.log('WhatsApp token OK at startup');
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

// Follow-ups
function clearFollowUps(from) {
  const timers = followUpTimers.get(from);
  if (timers) {
    if (timers.followUp1) clearTimeout(timers.followUp1);
    if (timers.followUp2) clearTimeout(timers.followUp2);
    followUpTimers.delete(from);
  }
}
function scheduleFollowUps(from) {
  clearFollowUps(from);

  // Follow-up 1: after 25 minutes
  const f1 = setTimeout(async () => {
    try {
      const msg = `Bro demo dekh liya?\nAgar spark slider chahiye, aaj Flipkart pe offer chal raha hai 🔥\nOrder → type ORDER\nPrice: ₹498 (COD)`;
      await sendWhatsAppText(from, msg);
      await forwardToMake({ from, text: '__followup_1__', aiReply: msg, userLang: 'en', intent: 'followup_1', timestamp: new Date().toISOString() });
    } catch (e) { console.error('followUp1 error', e); }
  }, 25 * 60 * 1000);

  // Follow-up 2: end of day (23:59 server time)
  const now = new Date();
  const eod = new Date(now);
  eod.setHours(23, 59, 0, 0);
  if (eod - now <= 0) eod.setDate(eod.getDate() + 1);
  const f2 = setTimeout(async () => {
    try {
      const msg = `Bro,\nAaj ka Flipkart price kabhi bhi change ho sakta hai ⚡\nAgar order karna hai to bol do ORDER\nMain link de dunga.`;
      await sendWhatsAppText(from, msg);
      await forwardToMake({ from, text: '__followup_2__', aiReply: msg, userLang: 'en', intent: 'followup_2', timestamp: new Date().toISOString() });
    } catch (e) { console.error('followUp2 error', e); }
  }, eod - now);

  followUpTimers.set(from, { followUp1: f1, followUp2: f2 });
}

// ----- OpenAI call (unchanged from your earlier logic, guarded)
const OPENAI_FALLBACK_REPLY = (FLIPKART_LINK, DEMO_VIDEO_LINK) =>
  `Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya Flipkart link bheju?\n\n 🏁 Price under ₹498 — Limited Stock hai! \n 🚀 Abhi order karlo Flipkart se 👇\n  ${FLIPKART_LINK}\n\n 💥 Flipkart delivery + easy returns — price badhne se pehle le lo\n\n ⚡ Riders pagal ho rahe hain iske liye!\n Demo video yahan dekho 👇  ${DEMO_VIDEO_LINK} ⚡\n\n 🔥 Chahiye under ₹498 mein? \n Bas reply karo BUY\n\n Use only in open safe space; avoid fuel/people. 😎`.trim();

const tunedSystemPrompt = `You are TurboBot MAX v2 — the official WhatsApp sales assistant for Turbo Thrill V5 Obsidian Feet Slider.
... (same system prompt content as before) ...
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
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Watch demo (10s): ${DEMO_VIDEO_LINK}. Reply BUY for the Flipkart link.` },
    { role: "user", content: "Buy" },
    { role: "assistant", content: `Grab it on Flipkart: ${FLIPKART_LINK}. Want help with order or COD options?` },
    { role: "user", content: "डेमो" },
    { role: "assistant", content: `डेमो देखें (10s): ${DEMO_VIDEO_LINK}। खरीदना है तो 'BUY' लिखें।` },
    { role: "user", content: "Demo bhai" },
    { role: "assistant", content: `Demo yahan dekho: ${DEMO_VIDEO_LINK} 🔥 Reply BUY for Flipkart link.` }
  ];

  const messages = [{ role: "system", content: tunedSystemPrompt }, ...examples, { role: "user", content: userMessage }];

  const payload = {
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
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
    text = text.replace(/\[Watch Demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);
    if (text.split(' ').length > 90) {
      text = text.split(' ').slice(0, 90).join(' ') + '...';
    }
    return text || OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return OPENAI_FALLBACK_REPLY(FLIPKART_LINK, DEMO_VIDEO_LINK);
  }
}

// ----- Intent detection (expanded and normalized)
function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();
  if (t === 'demo' || /\bdemo\b/.test(t) || /\bvideo\b/.test(t) || /\bwatch\b/.test(t)) return 'demo';
  if (t === 'order' || t === 'buy' || /\border\b/.test(t) || /\bbuy\b/.test(t) || /\bflipkart\b/.test(t) || /\blink\b/.test(t)) return 'buy';
  if (/\bprice\b/.test(t) || t.includes('₹') || t.includes('rupee')) return 'price';
  if (/\bkya\b|\bkya hai\b|\bkya karta\b/.test(t)) return 'what_is';
  if (t.length <= 12 && GREETING_REGEX.test(t)) return 'greeting';
  if (SPARKS_KEYWORD.test(t)) return 'sparks';
  return 'unknown';
}

// ----- HTTP endpoints
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
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = (changes && changes.value) ? changes.value : req.body;
    const messages = value.messages || [];
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const message = messages[0];
    const from = message.from;
    const rawText = (message.text && message.text.body) || '';
    const text = rawText.trim();
    const userLang = detectLangByScript(text);
    console.log(`incoming from=${from} lang=${userLang} text="${text.slice(0,200)}"`);

    // dedupe check early
    const preIntent = detectIntent(text);
    if (shouldSkipDuplicate(from, preIntent, text)) {
      const dupMsg = "I just sent that — did you get it? Reply YES if you didn't.";
      await sendWhatsAppText(from, dupMsg);
      await forwardToMake({ from, text, aiReply: dupMsg, userLang, intent: 'duplicate', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // Build the single reply according to highly deterministic rules:
    // Priority order:
    // 1) explicit demo / buy / price / what_is intents -> send welcome + intent block
    // 2) short greeting only -> send welcome only
    // 3) 'sparks' keyword -> send sparks info (safety line)
    // 4) short unknown message (<=80 chars) -> send combined welcome + fallback nudges
    // 5) else -> route to OpenAI and send single AI reply (with buy link appended if AI didn't provide it when intent=buy)

    let outgoing = '';
    let finalIntent = preIntent; // what we'll log

    // 1) explicit intents: demo, buy, price, what_is
    if (preIntent === 'demo' || preIntent === 'buy' || preIntent === 'price' || preIntent === 'what_is') {
      const welcomeBase = `Hey rider 👋🔥\nYe Turbo Thrill ka THRILL V5 Spark Slider hai!\nBoot drag karte hi REAL golden sparks nikalte hain 😎🔥\n\nNight rides, reels & group rides ke liye next-level!\nDemo chahiye? Bol do DEMO\nBuy karna hai? Bol do ORDER`;

      if (preIntent === 'demo') {
        const demoBlock = `🔥 Demo Video:\n${DEMO_VIDEO_LINK}\n\nWhy bikers love it:\n• Real spark metal plate\n• Heavy-duty build\n• Fits all boots\n• Easy install (tape + glue included)\n• Long lasting\n\nPrice today: ₹498 (COD Available)\nOrder karne ke liye bol do: ORDER`;
        outgoing = `${welcomeBase}\n\n${demoBlock}`;
        scheduleFollowUps(from);
      } else if (preIntent === 'buy') {
        const buyBlock = `Bro, Flipkart pe direct COD & fast delivery mil jayegi 👇\n${FLIPKART_LINK}\n\n⚡ Limited stock\n⚡ Original Turbo Thrill\n⚡ Easy returns\n⚡ Fast delivery`;
        outgoing = `${welcomeBase}\n\n${buyBlock}`;
        clearFollowUps(from);
        // log purchase intent
        try { await sendLead({ from, text, intent: 'buy', timestamp: new Date().toISOString() }); } catch(e){ console.error(e); }
      } else if (preIntent === 'price') {
        outgoing = `Bro price sirf ₹498 hai Flipkart pe.\nCOD + fast delivery mil jayegi.\nBuy → type ORDER`;
      } else if (preIntent === 'what_is') {
        outgoing = `Bro ye spark slider hai —\nBoot ke neeche laga kar drag karte hi\nREAL golden sparks nikalte hain 🔥\nNight rides aur reels ke liye OP effect deta hai 😎\n\nDemo → type DEMO\nOrder → type ORDER`;
      }

      // send single outgoing message
      await sendWhatsAppText(from, outgoing);
      await forwardToMake({ from, text, aiReply: outgoing, userLang, intent: finalIntent, timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // 2) short greeting only -> send welcome only
    if (preIntent === 'greeting') {
      const welcomeOnly = `Hey rider 👋🔥\nYe Turbo Thrill ka THRILL V5 Spark Slider hai!\nBoot drag karte hi REAL golden sparks nikalte hain 😎🔥\n\nNight rides, reels & group rides ke liye next-level!\nDemo chahiye? Bol do DEMO\nBuy karna hai? Bol do ORDER`;
      await sendWhatsAppText(from, welcomeOnly);
      await forwardToMake({ from, text, aiReply: welcomeOnly, userLang, intent: 'greeting', timestamp: new Date().toISOString() });
      return res.sendStatus(200);
    }

    // 3) sparks keyword -> info + safety
    if (SPARKS_KEYWORD.test(text)) {
      const sparkReply = userLang === 'hi' ? 'हाँ bro — sparks visual effect हैं, demo के लिए open space में use करो.' : 'Yes bro — sparks are a visual demo effect. Use only in open safe spaces.';
      await sendWhatsAppText(from, sparkReply);
      await forwardToMake({ from, text, aiReply: sparkReply, userLang, intent: 'info_sparks', timestamp: new Date().toISOString() });
      // schedule follow-ups as they might later want to buy
      scheduleFollowUps(from);
      return res.sendStatus(200);
    }

    // 4) short unknown messages -> welcome + fallback nudges
    if (text.length > 0 && text.length <= 80) {
      const fallback = `Hey rider 👋🔥\nYe Turbo Thrill ka THRILL V5 Spark Slider hai!\nBoot drag karte hi REAL golden sparks nikalte hain 😎🔥\n\nBro DEMO chahiye to type DEMO\nOrder karna hai to type ORDER\nMain yahi help kar dunga 🔥`;
      await sendWhatsAppText(from, fallback);
      await forwardToMake({ from, text, aiReply: fallback, userLang, intent: 'fallback', timestamp: new Date().toISOString() });
      scheduleFollowUps(from);
      return res.sendStatus(200);
    }

    // 5) longer or complex messages -> OpenAI handles answer (single send)
    let aiReply = await callOpenAI(text, userLang);

    // safety fallback if empty
    if (!aiReply || !aiReply.trim()) {
      aiReply = `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;
    }

    // If detected buy intent in text and AI didn't include flipkart link, append
    if (detectIntent(text) === 'buy' && !/flipkart/i.test(aiReply)) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    await sendWhatsAppText(from, aiReply);
    await forwardToMake({ from, text, aiReply, userLang, intent: 'ai_reply', timestamp: new Date().toISOString() });

    // schedule follow-ups for non-buy replies
    if (detectIntent(text) !== 'buy') scheduleFollowUps(from);

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (clean flow)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
