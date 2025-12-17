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

const FLIPKART_LINK =
  process.env.FLIPKART_LINK ||
  "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";

// n8n webhooks
const LEAD_LOGGER_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

const SMARTLINK_WEBHOOK_URL =
  process.env.SMARTLINK_WEBHOOK_URL;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const PORT = process.env.PORT || 3000;

// ----- SEND LEAD TO N8N -----
async function sendLead(payload) {
  try {
    await axios.post(LEAD_LOGGER_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000
    });
  } catch (e) {
    console.error('sendLead error:', e.message);
  }
}

// ----- GET SMARTLINK (RETURNS LINK + TOKEN) -----
async function getSmartLink(phone, intent = 'order') {
  try {
    const res = await axios.post(
      SMARTLINK_WEBHOOK_URL,
      {
        phone,
        click_id: '',
        msgid: '',
        campaign: 'whatsapp',
        adset: 'organic',
        creative: 'chat',
        src: 'whatsapp',
        intent
      },
      { timeout: 8000 }
    );

    return {
      smart_link: res.data?.smart_link || FLIPKART_LINK,
      token: res.data?.token || null
    };
  } catch (e) {
    console.error('Smartlink error:', e.message);
    return {
      smart_link: FLIPKART_LINK,
      token: null
    };
  }
}

// ----- SIMPLE HELPERS -----
function detectIntent(text = '') {
  const t = text.toLowerCase();
  if (t.includes('order') || t.includes('buy') || t.includes('link')) return 'order';
  if (t.includes('demo')) return 'demo';
  if (t.includes('price')) return 'price';
  return 'unknown';
}

// ----- WHATSAPP SEND -----
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v16.0/${PHONE_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
}

// ----- VERIFY WEBHOOK -----
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ----- MAIN WEBHOOK -----
app.post('/webhook', async (req, res) => {
  try {
    const messages =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];

    if (!messages.length) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body || '';
    const intent = detectIntent(text);

    let reply = '';

    // ---- ORDER FLOW (IMPORTANT PART) ----
    if (intent === 'order') {

      // 1️⃣ Get smartlink + token
      const { smart_link, token } = await getSmartLink(from, 'order');

      // 2️⃣ SAVE phone + token together (CRITICAL FIX)
      if (token) {
        await sendLead({
          from,
          smart_token: token,
          flipkart_clicked: true,
          timestamp: new Date().toISOString()
        });
      }

      // 3️⃣ Reply to user
      reply = `Bro, Flipkart pe COD & fast delivery 👇
${smart_link}

🔥 Limited stock
💯 Original Turbo Thrill
🚚 Fast delivery`;

    } else {
      reply = `Hey rider 👋🔥
Turbo Thrill Spark Slider

Demo → DEMO
Order → ORDER`;
    }

    await sendWhatsAppText(from, reply);

    // ---- NORMAL LEAD LOGGER (NO TOKEN HERE) ----
    await sendLead({
      from,
      text,
      intent,
      timestamp: new Date().toISOString()
    });

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get('/', (_, res) => res.send('TurboBot running'));
app.listen(PORT, () => console.log(`Running on ${PORT}`));
