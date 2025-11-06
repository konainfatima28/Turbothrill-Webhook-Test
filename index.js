// index.js - TurboThrill webhook (updated with verification, env overrides, and safety)
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Required env vars
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";

// Optional / overrides
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.25");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "";
const PORT = process.env.PORT || 3000;

// small helper to post text messages via WhatsApp Cloud API
async function sendWhatsAppText(to, text) {
  try {
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
    console.log('WhatsApp API response:', textRes.slice(0, 800));
    return r;
  } catch (e) {
    console.error('Error sending WhatsApp message', e);
    throw e;
  }
}

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
  // Basic disallowed-requests filter (quick)
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
      console.error('OpenAI unexpected response:', JSON.stringify(j).slice(0,1000));
      return '';
    }
    return j.choices[0].message.content.trim();
  } catch (e) {
    console.error('OpenAI call failed', e);
    return '';
  }
}

// VERIFY endpoint for Meta webhook verification (GET)
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
    // Support both direct WhatsApp Cloud payloads and forwarded payloads from Make
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = (changes && changes.value) ? changes.value : req.body;
    const messages = value.messages || [];
    if (!messages || messages.length === 0) {
      console.log('no messages in payload');
      return res.sendStatus(200);
    }
    const message = messages[0];
    const from = message.from; // user phone number
    const text = (message.text && message.text.body) || '';
    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = isHindi ? 'hi' : 'en';

    console.log(`message from ${from} lang=${userLang} text="${text.slice(0,200)}"`);

    // Call OpenAI to generate reply
    const aiReply = await callOpenAI(text);
    let finalReply = aiReply && aiReply.length ? aiReply : `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;

    // Send reply back via WhatsApp Cloud API
    try {
      await sendWhatsAppText(from, finalReply);
    } catch (e) {
      console.error('failed to send WhatsApp reply', e);
    }

    // Optional: forward lead data to Make.com for logging & followups
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ from, text, aiReply: finalReply, userLang, timestamp: new Date().toISOString() })
        });
      } catch (e) {
        console.error('Make webhook error', e);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot webhook running (v2)'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
