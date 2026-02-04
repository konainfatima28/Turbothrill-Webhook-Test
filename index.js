// index.js — TurboBot v2.2 (Shopify Order Tracking Enabled | 2026-safe)
require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ================= ENV =================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;

const WEBSITE_LINK = process.env.WEBSITE_LINK || "https://turbothrill.in";
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "support@turbothrill.in";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const PORT = process.env.PORT || 3000;

// ================= SHOPIFY =================
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

async function shopifyFetch(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return res.json();
}

async function findOrderByQuery(queryText) {
  const query = `
    query ($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            name
            displayFinancialStatus
            displayFulfillmentStatus
            fulfillments {
              trackingInfo {
                number
                url
                company
              }
            }
          }
        }
      }
    }
  `;

  const res = await shopifyFetch(query, { query: queryText });
  return res?.data?.orders?.edges?.[0]?.node || null;
}

// ================= SUPABASE =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function getUserState(phone) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_users?phone=eq.${phone}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const data = await res.json();
  return data[0] || null;
}

async function upsertUserState(payload) {
  await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_users`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
}

// ================= N8N =================
const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

// ================= STATE =================
const processedMessageIds = new Set();

const STEP = {
  IDLE: 'IDLE',
  AWAITING_ORDER_INPUT: 'AWAITING_ORDER_INPUT',
};

// ================= HELPERS =================
function detectIntent(text = '') {
  const t = text.toLowerCase().trim();
  if (t.includes('track')) return 'track';
  if (t.includes('order') || t.includes('buy')) return 'order';
  if (t.includes('price')) return 'price';
  if (t.includes('install')) return 'install';
  if (t.includes('bulk')) return 'bulk';
  if (t.includes('demo')) return 'demo';
  if (t.includes('human') || t.includes('agent')) return 'human';
  return 'unknown';
}

// ================= MESSAGES =================
const WELCOME_MESSAGE = `Hey there, Rider! 🔥

Welcome to Turbo Thrill! I can help with:
⚡ Order tracking
🏍️ Product info
💰 Pricing
📦 Shipping

Type:
TRACK | PRICE | ORDER | HUMAN`;

const MSG_TRACK_REQUEST = `Sure! 📦  
Please send your **order number**  
(example: #1023)`;

const MSG_ORDER = `Order here 🔥
${WEBSITE_LINK}

💰 1pc ₹449
⭐ 2pc ₹849 (Best Seller)
🌙 4pc ₹1,649

FREE shipping | Prepaid only`;

const MSG_PRICE = `Pricing 💰

1pc ₹449
2pc ₹849 ⭐
4pc ₹1,649
6pc ₹2,499
10pc ₹3,999

Order → ${WEBSITE_LINK}`;

const MSG_INSTALL = `Installation 🛠️
1. Clean sole
2. Stick slider
3. Press 60 sec
4. Wait 24 hrs

Demo:
${DEMO_VIDEO_LINK}`;

const MSG_BULK = `Bulk orders 👥
Visit:
${WEBSITE_LINK}

Need custom qty?
${SUPPORT_CONTACT}`;

const MSG_DEMO = `Demo 🔥
${DEMO_VIDEO_LINK}

Order:
${WEBSITE_LINK}`;

const MSG_HUMAN = `Connecting you to support 👤

🕐 10 AM – 7 PM
📧 ${SUPPORT_CONTACT}`;

const MSG_FALLBACK = `Please type:
TRACK | PRICE | ORDER | HUMAN`;

// ================= SENDERS =================
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_ID) return;

  await fetch(`https://graph.facebook.com/v16.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

async function sendLead(data) {
  try {
    await axios.post(MAKE_WEBHOOK_URL, data, { timeout: 8000 });
  } catch {}
}

// ================= WEBHOOK VERIFY =================
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ================= WEBHOOK HANDLER =================
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;
    if (processedMessageIds.has(msgId)) return res.sendStatus(200);
    processedMessageIds.add(msgId);

    const from = message.from;
    const text = message.text?.body || '';

    const user = await getUserState(from);
    const currentStep = user?.step || STEP.IDLE;

    await upsertUserState({ phone: from, step: currentStep });

    // ===== TRACK FLOW =====
    if (currentStep === STEP.AWAITING_ORDER_INPUT) {
      const order = await findOrderByQuery(text);

      if (!order) {
        await sendWhatsAppText(
          from,
          `Order not found 😕  
Please check order number or type HUMAN`
        );
      } else {
        const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];
        let reply = `📦 Order ${order.name}
💳 ${order.displayFinancialStatus}
🚚 ${order.displayFulfillmentStatus}`;

        if (tracking?.url) {
          reply += `

🔗 Track:
${tracking.url}`;
        }

        await sendWhatsAppText(from, reply);
      }

      await upsertUserState({ phone: from, step: STEP.IDLE });
      return res.sendStatus(200);
    }

    const intent = detectIntent(text);

    if (intent === 'track') {
      await sendWhatsAppText(from, MSG_TRACK_REQUEST);
      await upsertUserState({ phone: from, step: STEP.AWAITING_ORDER_INPUT });
      return res.sendStatus(200);
    }

    let reply = MSG_FALLBACK;
    if (intent === 'order') reply = MSG_ORDER;
    else if (intent === 'price') reply = MSG_PRICE;
    else if (intent === 'install') reply = MSG_INSTALL;
    else if (intent === 'bulk') reply = MSG_BULK;
    else if (intent === 'demo') reply = MSG_DEMO;
    else if (intent === 'human') reply = MSG_HUMAN;

    await sendWhatsAppText(from, reply);
    await sendLead({ from, text, intent });

    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(500);
  }
});

// ================= SERVER =================
app.get('/', (_, res) => res.send('TurboBot v2.2 running 🔥'));
app.listen(PORT, () => console.log(`TurboBot running on ${PORT}`));
