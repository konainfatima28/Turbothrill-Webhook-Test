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

if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) {
  console.warn('⚠️ Shopify credentials missing. Order tracking will not work.');
}

async function shopifyFetch(query, variables = {}) {
  try {
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

    if (!res.ok) {
      const errorText = await res.text();
      console.error('❌ Shopify API error:', res.status, errorText);
      return null;
    }

    const json = await res.json();

    if (json.errors) {
      console.error('❌ Shopify GraphQL errors:', JSON.stringify(json.errors));
      return null;
    }

    return json;
  } catch (err) {
    console.error('❌ Shopify fetch failed:', err.message);
    return null;
  }
}

async function findOrderByLookup(text) {
  const { query } = detectOrderLookupType(text);
  if (!query) return null;

  const gql = `
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

  const res = await shopifyFetch(gql, { query });
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
function detectOrderLookupType(text = '') {
  const t = text.trim();

  // Order number (#1023)
  if (t.startsWith('#')) {
    return { type: 'order_number', query: `name:${t}` };
  }

  // Email
  if (t.includes('@')) {
    return { type: 'email', query: `email:${t}` };
  }

  // Phone (10+ digits)
  const cleanPhone = t.replace(/\D/g, '');
  if (cleanPhone.length >= 10) {
    return { type: 'phone', query: `phone:${cleanPhone}` };
  }

  return { type: 'unknown', query: null };
}

function looksLikeOrderLookup(text = '') {
  const t = text.trim();
  if (t.startsWith('#')) return true;
  if (t.includes('@')) return true;
  if (t.replace(/\D/g, '').length >= 10) return true;
  return false;
}

function detectIntent(text = '') {
  const t = text.toLowerCase().trim();

    // Greetings
  if (
    t === 'hi' ||
    t === 'hello' ||
    t === 'hey' ||
    t === 'hii' ||
    t === 'namaste'
  ) return 'greeting';

  if (t.includes('track')) return 'track';
  if (t.includes('order') || t.includes('buy')) return 'order';
  if (t.includes('price') || t.includes('cost')) return 'price';
  if (t.includes('product') || t.includes('details') || t.includes('v5')) return 'product';
  if (t.includes('install') || t.includes('lagana')) return 'install';
  if (t.includes('bulk') || t.includes('group')) return 'bulk';
  if (t.includes('demo') || t.includes('video')) return 'demo';
  if (t.includes('shipping') || t.includes('delivery')) return 'shipping';
  if (t.includes('cod') || t.includes('cash')) return 'cod';
  if (t.includes('refund') || t.includes('return')) return 'return';
  if (
    t.includes('safe') ||
    t.includes('danger') ||
    t.includes('illegal') ||
    t.includes('police') ||
    t.includes('law')
  ) return 'safety';
  if (t.includes('human') || t.includes('agent')) return 'human';

  return 'unknown';
}

function isBusinessHours() {
  const now = new Date();
  const istHour = (now.getUTCHours() + 5.5) % 24;
  return istHour >= 10 && istHour < 19;
}

// ================= MESSAGES =================
const WELCOME_MESSAGE = `Hey there, Rider! 🔥

Welcome to *Turbo Thrill* ⚡  
I can help you with:

1️⃣ Track my order  
2️⃣ Product details  
3️⃣ Pricing & offers  
4️⃣ Place order  
5️⃣ Talk to human 👤  

Reply with the *number* or your question 😊`;

const MSG_TRACK_REQUEST = `Sure! 📦  
Please send **any one** of these:

• Order number (example: #1023)
• Mobile number used in order
• Email used at checkout

I’ll find it for you instantly 🔍`;

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

const MSG_FALLBACK = `I can help you with 😊

• Track your order
• Product details
• Pricing & offers
• Talk to human

Just type what you need 👇`;

const MSG_PRODUCT = `Great choice! 🔥 Turbo Thrill V5 Obsidian special:

✨ Creates MASSIVE golden sparks
🪨 Volcanic alloy – super durable
🧲 3M VHB adhesive (35mm × 45mm)
🛡️ Quality ABS body
💪 Trusted by 400+ riders

💰 Price:
1 piece → ₹449 (70% OFF)

Reply:
INSTALL | PRICE | ORDER`;

const MSG_SHIPPING = `Here’s the delivery scoop 📦

🚀 Processing: within 24 hours
🏙️ Metro cities: 3–4 days
🌆 Tier 2 cities: 4–6 days
🏞️ Remote areas: 5–7 days

✅ FREE shipping
❌ COD not available (prepaid only)

Track anytime via WhatsApp 🔥`;

const MSG_COD = `Good question! 💡 We’re prepaid only because:

✅ Prices stay LOW (₹449 vs ₹1,499)
✅ Faster delivery (no COD delays)
✅ Better tracking & support
✅ FREE shipping

We accept:
UPI • Cards • Net Banking • Wallets

Order here:
${WEBSITE_LINK}`;

const MSG_SAFETY = `Safety first ⚠️

✅ Always wear full riding gear
• Helmet
• Jacket
• Gloves
• Riding boots

⚠️ Use only in safe, controlled areas
⚠️ Check local laws
⚠️ Sparks reduce traction slightly
⚠️ 18+ riders only

Ride safe 🏍️`;

const MSG_RETURN = `We’ve got you covered 🛡️

✅ 7-Day Quality Guarantee

You can return if:
• Item damaged in transit
• Manufacturing defect
• Wrong item received
• Unused & original packaging

📧 Email: ${SUPPORT_CONTACT}
Send:
• Order number
• Issue details
• Photos

⏱️ Response within 24 hrs
💰 Refund in 5–7 days`;

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

    // auto cleanup after 1 hour
    setTimeout(() => {
      processedMessageIds.delete(msgId);
    }, 60 * 60 * 1000);

    const from = message.from;
    const text = message.text?.body || '';
    const normalizedText = text.trim();

    const user = await getUserState(from);
    
    // FIRST-TIME USER WELCOME
    if (!user) {
      await sendWhatsAppText(from, WELCOME_MESSAGE);
      await upsertUserState({
        phone: from,
        step: STEP.IDLE,
        last_seen: new Date().toISOString(),
      });
      return res.sendStatus(200);
    }


    const currentStep = user.step;

    // ===== TRACK FLOW =====
    if (currentStep === STEP.AWAITING_ORDER_INPUT) {

      if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) {
        await sendWhatsAppText(
          from,
`Order tracking is temporarily unavailable 😕  
Please type *HUMAN* to connect with support.`
        );
        return res.sendStatus(200);
      }
    
      const order = await findOrderByLookup(normalizedText);

      if (!order) {
        await sendWhatsAppText(
          from,
`I couldn’t find an order with that info 😕  

Please try again with:
• Order number
• Phone
• Email  

Or type *HUMAN* for help 👤`
        );
        
      } else {
        const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];
        let reply = `📦 Order ${order.name}
💳 ${order.displayFinancialStatus}
🚚 ${order.displayFulfillmentStatus}`;

        if (tracking?.url) {
          reply += `

🔗 Track your shipment:
${tracking.url}`;
        } else {
          reply += `
📍 Tracking will be available once shipped`;
        }

        await sendWhatsAppText(from, reply);
      }

      await upsertUserState({ phone: from, step: STEP.IDLE });
      return res.sendStatus(200);
    }

    let intent;

    if (['1','2','3','4','5'].includes(text.trim())) {
      const map = {
        '1': 'track',
        '2': 'product',
        '3': 'price',
        '4': 'order',
        '5': 'human'
      };
      intent = map[text.trim()];
    } else {
      intent = detectIntent(text);
    }

    // 🔁 User sent order info directly (even without typing TRACK)
    if (
      currentStep === STEP.IDLE &&
      looksLikeOrderLookup(normalizedText)
    ) {
      const order = await findOrderByLookup(normalizedText);
    
      if (!order) {
        await sendWhatsAppText(
          from,
    `I couldn’t find an order with that info 😕  
    
    Please try again with:
    • Order number
    • Phone
    • Email  
    
    Or type *HUMAN* for help 👤`
        );
      } else {
        const tracking = order.fulfillments?.[0]?.trackingInfo?.[0];
        let reply = `📦 Order ${order.name}
    💳 ${order.displayFinancialStatus}
    🚚 ${order.displayFulfillmentStatus}`;
    
        if (tracking?.url) {
          reply += `
    
    🔗 Track your shipment:
    ${tracking.url}`;
        } else {
          reply += `
    📍 Tracking will be available once shipped`;
        }
    
        await sendWhatsAppText(from, reply);
      }
    
      return res.sendStatus(200);
    }

    if (intent === 'track') {
      await sendWhatsAppText(from, MSG_TRACK_REQUEST);
      await upsertUserState({ phone: from, step: STEP.AWAITING_ORDER_INPUT });
      return res.sendStatus(200);
    }

    let reply = MSG_FALLBACK;
    
    if (intent === 'greeting') reply = WELCOME_MESSAGE;
    else if (intent === 'order') reply = MSG_ORDER;
    else if (intent === 'return') reply = MSG_RETURN;
    else if (intent === 'price') reply = MSG_PRICE;
    else if (intent === 'install') reply = MSG_INSTALL;
    else if (intent === 'bulk') reply = MSG_BULK;
    else if (intent === 'demo') reply = MSG_DEMO;
    else if (intent === 'shipping') reply = MSG_SHIPPING;
    else if (intent === 'cod') reply = MSG_COD;
    else if (intent === 'safety') reply = MSG_SAFETY;
    else if (intent === 'product') reply = MSG_PRODUCT;
    else if (intent === 'human') {
      if (isBusinessHours()) {
        reply = `Connecting you to our support team 👤

🕐 We’re available now
📧 ${SUPPORT_CONTACT}

Please briefly describe your issue 🙏`;
        } else {
          reply = `Our team is currently offline 🌙

🕐 Business hours:
10 AM – 7 PM (Mon–Sat)
      
Meanwhile, I can help with:
  • Order tracking
  • Product details
  • Pricing & shipping
      
Or email us:
${SUPPORT_CONTACT}`;
        }
      }
         

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
