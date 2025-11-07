// index.js - TurboThrill webhook (patched for safety & token health checks)
require('dotenv').config(); // optional for local .env support; harmless in Render

const express = require('express');
const fetch = require('node-fetch'); // using node-fetch v2 (require-compatible)
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ----- Defensive global handlers (prevent process exit on uncaught errors)
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
  // do not exit; render will keep process alive for debugging
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION:', reason);
  // do not exit; just log
});

// ----- Environment variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.25");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

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

// ----- System prompt and OpenAI call (guarded)
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

async function callOpenAI(userMessage) {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }

  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'how to create fire', 'harmful', 'explode', 'detonate', 'arson', 'poison'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't help with instructions that are dangerous or illegal. Please contact human support at ${SUPPORT_CONTACT || 'our support team'} for safe alternatives.`;
    }
  }

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE
      })
    });
    const j = await resp.json();
    if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
      console.error('OpenAI unexpected response:', JSON.stringify(j).slice(0, 1000));
      return '';
    }
    return j.choices[0].message.content.trim();
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return '';
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
    const userLang = isHindi ? 'hi' : 'en';

    console.log(`message from ${from} lang=${userLang} text="${text.slice(0,200)}"`);

    // generate reply via OpenAI (guarded)
    const aiReply = await callOpenAI(text);
    const finalReply = (aiReply && aiReply.length) ? aiReply : `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;

    // attempt send (this is guarded inside sendWhatsAppText)
    await sendWhatsAppText(from, finalReply);

    // forward to Make (optional)
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ from, text, aiReply: finalReply, userLang, timestamp: new Date().toISOString() })
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

app.get('/', (req, res) => res.send('TurboBot webhook running (v2)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
