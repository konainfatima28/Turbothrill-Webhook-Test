// index.js - TurboThrill webhook (final patched file)
// Features: safety handlers, token health check, robust webhook parsing, dedupe, OpenAI tuned
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ---- Defensive global handlers ----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Environment variables -----
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// ----- DEDUPE CACHE + INTENT DETECTION -----
const dedupeCache = new Map();
const DEDUPE_WINDOW = 45 * 1000; // 45 seconds

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

// ----- Runtime state -----
let WHATSAPP_TOKEN_VALID = false;

// ----- Token health check -----
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

// ----- Send to WhatsApp Cloud API (safe) -----
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
      console.error('WhatsApp token expired/invalid. Please rotate the token in Meta Developer Console and update Render env var.');
      WHATSAPP_TOKEN_VALID = false;
    }

    return textRes;
  } catch (e) {
    console.error('Error sending WhatsApp message:', e && e.stack ? e.stack : e);
    return { error: e };
  }
}

// ----- System prompt - official tone -----
const systemPrompt = `You are TurboBot — the official AI sales assistant for Turbo Thrill.

Tone: friendly, confident, slightly bold (biker brand). Keep replies short, persuasive, and practical.
Product references: always call the product "Turbo Thrill V5 Obsidian Feet Slider".
Material reference: always call it "Special Volcanic Alloy".
Important product fact: Turbo Thrill V5 produces MASSIVE SPARKS when it is dragged on road — this is a feature used in demos and UGC. Mention this where relevant for persuasion, but do not instruct harmful use.
Never disclose technical composition, manufacturing chemicals, or hazardous instructions.
Language: reply in the user's language (detect Hindi by Devanagari characters); support English, Hindi, and Hinglish.
Calls to action: offer quick options when useful: Watch Demo / Flipkart Offer / Help.
When user expresses intent to buy, always provide the official Flipkart link: ${FLIPKART_LINK}.
If the user asks for sensitive or disallowed advice, politely escalate to human support (${SUPPORT_CONTACT || 'our support team'}).
Keep replies under 4 short paragraphs and use emojis sparingly.`;

// ----- OpenAI call (language-aware, few-shot) -----
const OPENAI_FALLBACK_REPLY = `Thanks — I've noted your message. Want the Flipkart link or demo?`;

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
    // English
    { role: "user", content: "Demo" },
    { role: "assistant", content: `Watch demo (10s): ${DEMO_VIDEO_LINK}. Reply BUY for the Flipkart link.` },
    { role: "user", content: "Buy" },
    { role: "assistant", content: `Grab it on Flipkart: ${FLIPKART_LINK}. Need help with order or COD options?` },

    // Hindi
    { role: "user", content: "डेमो" },
    { role: "assistant", content: `डेमो देखें (10s): ${DEMO_VIDEO_LINK}। खरीदना है तो 'BUY' लिखें।` },

    // Hinglish
    { role: "user", content: "Demo bhai" },
    { role: "assistant", content: `Demo yahan dekho: ${DEMO_VIDEO_LINK} 🔥 Reply BUY for Flipkart link.` }
  ];

  const messages = [
    { role: "system", content: systemPrompt },
    ...examples,
    { role: "user", content: userMessage }
  ];

  const payload = {
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
    messages,
    max_tokens: Math.min(300, MAX_TOKENS || 200),
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
      return OPENAI_FALLBACK_REPLY;
    }

    let text = j.choices[0].message.content.trim();

    // Replace placeholder bracket links if present
    text = text.replace(/\[Watch Demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);
    text = text.replace(/\[watch demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);

    // Safety trim
    if (text.split(' ').length > 120) {
      text = text.split(' ').slice(0, 120).join(' ') + '...';
    }

    return text || OPENAI_FALLBACK_REPLY;
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return OPENAI_FALLBACK_REPLY;
  }
}

// ======= GET verification route (for Meta webhook verification) =======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      console.warn('WEBHOOK verification failed - tokens do not match');
      return res.sendStatus(403);
    }
  }
  return res.status(200).send('OK');
});

// ======= POST webhook handler (robust parsing) =======
app.post('/webhook', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [req.body];
    const jobs = [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [{ value: entry }];
      for (const change of changes) {
        const value = change.value || {};
        console.log('incoming body keys (change.value):', Object.keys(value));

        if (Array.isArray(value.messages) && value.messages.length > 0) {
          for (const message of value.messages) {
            jobs.push(processIncomingMessage({ raw: value, message }));
          }
          continue;
        }

        if (Array.isArray(value.statuses) && value.statuses.length > 0) {
          console.log('Received statuses (delivery/read) event. Ignoring in bot flow.');
          continue;
        }

        if (Array.isArray(value.contacts) && value.contacts.length > 0) {
          console.log('Received contacts event:', JSON.stringify(value.contacts).slice(0, 1000));
          continue;
        }

        console.log('No user messages found in change.value. Keys:', Object.keys(value));
      }
    }

    // concurrency-safe execution of jobs
    const CONCURRENCY = 10;
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + CONCURRENCY));
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error (top):', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

// ----- Helper: process individual incoming message -----
async function processIncomingMessage({ raw, message }) {
  try {
    const from = message.from || raw.from || message.author || (message?.sender?.id) || null;
    const timestamp = raw.timestamp || message.timestamp || Date.now();

    let text = '';
    if (message.text && message.text.body) {
      text = message.text.body;
    } else if (message.interactive) {
      if (message.interactive.button_reply && message.interactive.button_reply.title) {
        text = message.interactive.button_reply.title;
      } else if (message.interactive.list_reply && message.interactive.list_reply.title) {
        text = message.interactive.list_reply.title;
      } else {
        text = JSON.stringify(message.interactive).slice(0, 1000);
      }
    } else if (message.type) {
      text = `[${message.type} message]`;
    }

    if (!from) {
      console.warn('processIncomingMessage: could not determine sender (from). Skipping.');
      return;
    }

    const isHindi = /[ऀ-ॿ]/.test(text || '');
    const userLang = isHindi ? 'hi' : 'en';
    console.log(`message from ${from} lang=${userLang} text="${(text||'').slice(0,200)}"`);

    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate ${intent} from ${from}`);
      // fire-and-forget confirmation
      sendWhatsAppText(from, "I just sent that — did you get the demo? Reply YES if you didn't.")
        .catch(e => console.error('confirmation send error', e));
      return;
    }

    // Avoid calling OpenAI for empty/non-text message payloads
    if (!text || text.trim().length === 0 || /^\[.*\]$/.test(text)) {
      let fallback = `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;
      if (intent === 'buy' && !fallback.toLowerCase().includes('flipkart')) {
        fallback = `${fallback}\n\nBuy here: ${FLIPKART_LINK}`;
      }
      await sendWhatsAppText(from, fallback);
      return;
    }

    // call OpenAI
    let aiReply = await callOpenAI(text, userLang);
    if (!aiReply || !aiReply.trim()) {
      aiReply = `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;
    }

    if (intent === 'buy' && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    await sendWhatsAppText(from, aiReply);

    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ from, text, aiReply, userLang, timestamp: new Date().toISOString(), rawSummary: Object.keys(raw) })
        });
      } catch (e) {
        console.error('Make webhook error', e && e.message ? e.message : e);
      }
    }
  } catch (err) {
    console.error('processIncomingMessage error:', err && err.stack ? err.stack : err);
  }
}

// ----- Health route and server start -----
app.get('/', (req, res) => res.send('TurboBot webhook running (v2)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
