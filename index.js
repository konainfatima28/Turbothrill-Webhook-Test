// index.js - TurboBot v2.0 - Complete Automation with Quick Commands
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
const OPENAI_KEY = process.env.OPENAI_KEY;
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22?pid=FRFH5YDBA7YZ4GGS";
const WEBSITE_LINK = process.env.WEBSITE_LINK || "https://turbothrill.in/products/turbo-thrill-v5-obsidian-feet-slider";

// n8n webhook URLs
const DEFAULT_MAKE_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:5678/webhook-test/lead-logger'
    : 'https://turbothrill-n8n.onrender.com/webhook/lead-logger';

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || DEFAULT_MAKE_WEBHOOK_URL;
const N8N_SECRET = process.env.N8N_SECRET || '';

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45");
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "support@turbothrill.in";
const TRACKING_LINK = process.env.TRACKING_LINK || "https://turbo-thrill.shiprocket.co/tracking";
const PORT = process.env.PORT || 3000;

// unified sendLead using axios (for n8n + Google Sheet)
async function sendLead(leadData) {
  if (!MAKE_WEBHOOK_URL) {
    console.warn('MAKE_WEBHOOK_URL not set — skipping forwarding to n8n');
    return;
  }
  try {
    console.log('[sendLead] Sending to n8n URL:', MAKE_WEBHOOK_URL);
    await axios.post(MAKE_WEBHOOK_URL, leadData, {
      headers: {
        'Content-type': 'application/json',
        ...(N8N_SECRET ? { 'x-n8n-secret': N8N_SECRET } : {})
      },
      timeout: 10000
    });
    console.log('Lead forwarded to n8n');
  } catch (err) {
    console.error(
      'Failed to send lead to n8n:',
      err?.response?.status,
      err?.response?.data || err.message || err
    );
  }
}

// ----- Defensive global handlers -----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ----- Regex & heuristics -----
const SAFETY_KEYWORDS = /(spark|sparks|fire|danger|safe|legal|police)/i;

// detect language
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

// ---- INTENT DETECTION ----
function isHighIntent(text = '') {
  const t = text.toLowerCase();
  const HIGH_INTENT_KEYWORDS = [
    'order', 'buy', 'purchase', 'checkout', 'link',
    'order kar', 'order karna', 'mang', 'mangwana',
    'kharid', 'buy kar', 'link bhejo', 'link bhej do',
    'website', 'site'
  ];
  return HIGH_INTENT_KEYWORDS.some(k => t.includes(k));
}

function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().trim();

  // QUICK COMMANDS (exact match for better UX)
  if (t === 'track') return 'track';
  if (t === 'order') return 'order';
  if (t === 'price') return 'price';
  if (t === 'return') return 'return';
  if (t === 'human') return 'human';
  if (t === 'install') return 'install';
  if (t === 'safety') return 'safety';
  if (t === 'bulk') return 'bulk';
  if (t === 'demo') return 'demo';

  // DEMO
  if (t.includes('demo') || t.includes('reel') || t.includes('video')) {
    return 'demo';
  }

  // ORDER / BUY / LINK / WEBSITE
  if (
    t.includes('order') || t.includes('buy') ||
    t.includes('website') || t.includes('link') ||
    t.includes('site')
  ) {
    return 'order';
  }

  // TRACKING
  if (
    t.includes('track') || t.includes('order status') ||
    t.includes('kaha hai') || t.includes('delivery')
  ) {
    return 'track';
  }

  // PRICE
  if (
    t.includes('price') || t.includes('kitna') || t.includes('kitne') ||
    t.includes('cost') || t.includes('rs ') || t.includes('₹')
  ) {
    return 'price';
  }

  // SHIPPING
  if (
    t.includes('shipping') || t.includes('delivery time') ||
    t.includes('kitne din') || t.includes('kab milega') ||
    t.includes('free shipping') || t.includes('cod')
  ) {
    return 'shipping';
  }

  // RETURN/REFUND
  if (
    t.includes('return') || t.includes('refund') ||
    t.includes('exchange') || t.includes('wapas')
  ) {
    return 'return';
  }

  // WARRANTY/GUARANTEE
  if (
    t.includes('warranty') || t.includes('guarantee')
  ) {
    return 'warranty';
  }

  // LIFESPAN/DURABILITY
  if (
    t.includes('how long') || t.includes('lifespan') ||
    t.includes('durability') || t.includes('kitne din chalega')
  ) {
    return 'lifespan';
  }

  // SHOE DAMAGE
  if (
    t.includes('damage shoe') || t.includes('shoe damage') ||
    t.includes('juta kharab')
  ) {
    return 'shoe_damage';
  }

  // WHAT IS THIS / KYA HAI
  if (
    t.includes('kya hai') || t.includes('kya karta') ||
    t.includes('what is this') || t.includes('ye kya') ||
    t.includes('use kaise') || t.includes('how to use')
  ) {
    return 'what';
  }

  // INSTALL
  if (
    t.includes('install') || t.includes('lagana') ||
    t.includes('kaise lagaye') || t.includes('how to attach')
  ) {
    return 'install';
  }

  // BULK
  if (
    t.includes('bulk') || t.includes('crew') ||
    t.includes('group') || t.includes('4 piece') ||
    t.includes('6 piece') || t.includes('10 piece')
  ) {
    return 'bulk';
  }

  if (t.includes('help') || t.includes('support') || t.includes('agent')) return 'human';

  return 'unknown';
}

// ----- AUTOMATED RESPONSE MESSAGES (Exact from automation guide) -----

const WELCOME_MESSAGE = `Hey there, Rider! 🔥

Welcome to Turbo Thrill! I'm here 24/7 to help with:

⚡ Order tracking
🏍️ Product info
📦 Shipping details
🔄 Returns/refunds
💰 Pricing & offers

What can I help you with today?

(Type the number or your question)
1️⃣ Track my order
2️⃣ Product details
3️⃣ Place order
4️⃣ Talk to human`;

const MSG_TRACK_REQUEST = `Sure! Let me track that for you 📦

Please share your:
• Order number (e.g., #TT12345)
OR
• Registered mobile number or email

I'll fetch the latest status instantly!`;

const MSG_TRACK_LINK = `Track your order yaha se! 📦

🔗 ${TRACKING_LINK}

Order number chahiye? Check confirmation email/SMS.

Need help? Reply with order number!`;

const MSG_ORDER_NOT_FOUND = `Hmm, I couldn't find that order number 🤔

Please check:
• Is the order number correct?
• Did you order from turbothrill.in?

Still having issues?
Type "HUMAN" to connect with our support team (10 AM - 7 PM)`;

const MSG_PRODUCT_INFO = `Great choice! Here's what makes Turbo Thrill V5 Obsidian special 🔥

✨ Creates MASSIVE sparks instantly
🪨 Volcanic alloy - super durable
🧲 Strong 3M VHB adhesive (35mm x 45mm)
🛡️ Quality ABS material body
💪 Trusted by 400+ riders

💰 Price:
1 piece → ₹449 (70% OFF MRP ₹1,499!)

Want to:
1️⃣ See installation video
2️⃣ Check delivery time
3️⃣ Place order now
4️⃣ Ask more questions`;

const MSG_DEMO = `🔥 Demo Video:
${DEMO_VIDEO_LINK}

Why bikers love it:
• Special volcanic alloy
• Quality ABS body
• 3M VHB tape included
• Easy install
• Long lasting

Price: ₹449 (70% OFF!)
🚚 FREE Shipping
💳 Prepaid only

Order → type ORDER`;

const MSG_ORDER = `Bro, yaha se direct order kar sakte ho! 👇

🌐 Website: ${WEBSITE_LINK}

💰 AMAZING PRICES:
• 1pc → ₹449 (MRP ₹1,499)
• 2pc → ₹849 🔥 BEST SELLER
• 4pc → ₹1,649 🌙 Night Rider Pack
• 6pc → ₹2,499 (Crew Pack)
• 10pc → ₹3,999 (Riding Group)

✨ FREE Shipping on ALL orders!
💳 100% Secure Payment (Prepaid only)
📦 Delivery in 3-7 days

🔥 Pro tip: 2 pieces = dono boots se heavy sparks!

Flipkart pe bhi available: ${FLIPKART_LINK}`;

const MSG_PRICE = `Here are our spark-tastic deals! 💰

🔥 SOLO RIDER
1 piece → ₹449 (MRP ₹1,499)
Save 70%! 🎉

⭐ BEST SELLER (Most Popular!)
2 pieces → ₹849
💵 Save ₹2,149!

🌙 NIGHT RIDER PACK
4 pieces → ₹1,649
💵 Save ₹4,347!

👥 CREW PACK
6 pieces → ₹2,499
💵 Save ₹6,495!

🎉 RIDING GROUP
10 pieces → ₹3,999
💵 Save ₹10,991!

✨ FREE shipping on ALL orders
🚚 Delivery: 3-7 days across India
💳 Prepaid orders only

Ready to order? Visit:
🔗 ${WEBSITE_LINK}`;

const MSG_WHAT = `Bro ye spark slider hai —
Boot ke neeche laga kar drag karte hi
REAL golden sparks nikalte hain 🔥

✨ Special volcanic alloy material
🛡️ Quality ABS body
🧲 3M VHB tape (35mm x 45mm) included

Night rides aur reels ke liye OP effect! 😎

Demo → type DEMO
Price → type PRICE
Order → type ORDER`;

const MSG_SHIPPING = `Here's the delivery scoop! 📦

🚀 Processing: Maximum 24 hours
🏙️ Metro cities: 3-4 days
🌆 Tier 2 cities: 4-6 days
🏞️ Remote areas: 5-7 days

💰 Shipping:
• 100% FREE on ALL orders! 🎉
• No minimum order value
• Prepaid orders only

📍 We deliver PAN India!

Track your order anytime:
🔗 ${TRACKING_LINK}

Need specific pin code check? Send me your pin code!`;

const MSG_RETURN = `We've got you covered! 🛡️

7-Day Quality Guarantee ✅

You can return if:
✅ Product damaged during shipping
✅ Manufacturing defect
✅ Wrong item received
✅ Unused & in original pack

How to return:
1. Email: ${SUPPORT_CONTACT}
2. Send order # + photos
3. Get approval in 24 hrs
4. Ship back (we cover if defective)
5. Get refund in 5-7 days

Already have an issue? Type "RETURN REQUEST"

Note: We don't offer exchanges or store credit - only refunds to original payment method.`;

const MSG_INSTALL = `Installing is super easy! 🛠️

Watch our tutorial:
🎥 ${DEMO_VIDEO_LINK}

Quick steps:
1. Clean shoe sole thoroughly
2. Remove 3M VHB tape backing
3. Press slider firmly for 60 seconds
4. Wait 24 hours before riding
5. Go spark! 🔥

Need help? I'm here 24/7 or contact our team during business hours (10 AM - 7 PM)`;

const MSG_BULK = `Awesome! You're building a spark crew! 👥

Check out our bulk packs:

🌙 NIGHT RIDER PACK
4 pieces → ₹1,649
Perfect for small groups

👥 CREW PACK
6 pieces → ₹2,499
Most popular for crews!

🎉 RIDING GROUP
10 pieces → ₹3,999
Ultimate squad pack

All with:
🎯 Priority processing
📦 Possible same-day shipping
🚚 FREE delivery
🤝 Dedicated support

Order now: ${WEBSITE_LINK}

Need custom quantity? Email: ${SUPPORT_CONTACT}`;

const MSG_WARRANTY = `We offer a 7-Day Quality Guarantee! 🛡️

Covers:
✅ Manufacturing defects
✅ Damaged during shipping
✅ Component issues (volcanic alloy displaced)
✅ Missing VHB tape

Full policy: turbothrill.in/policies/refund-policy

Need to file a claim? Type "RETURN REQUEST"`;

const MSG_LIFESPAN = `Product lifespan varies based on usage! 🔥

Factors:
• Riding frequency
• Road surface type
• Spark intensity/duration
• Riding style

The volcanic alloy wears naturally with use - this is normal and expected.

Average: 10-30 rides (varies widely)

When it stops sparking, it's time for a fresh one!

Ready to stock up? Check our bulk packs at ${WEBSITE_LINK} 🎯`;

const MSG_SHOE_DAMAGE = `Good question! 👟

The slider attaches to the OUTSIDE of your shoe sole using 3M VHB tape, so:
✅ No damage to shoe interior
✅ Shoe remains wearable normally

Note:
• Minimal wear on sole possible
• Don't walk extensively with slider attached
• Best on riding boots with hard soles

Questions? Ask away!`;

const MSG_COD = `We accept prepaid orders only! 💳

Why? So we can offer:
✅ 70% discount (₹449 vs ₹1,499!)
✅ Faster delivery
✅ Better support
✅ FREE shipping

Payment options:
• UPI (GPay, PhonePe, Paytm)
• Credit/Debit Cards
• Net Banking
• Digital Wallets

All 100% secure! 🔒

Order now: ${WEBSITE_LINK}`;

const MSG_SAFETY = (lang) => (
  lang === 'hi'
    ? `Safety first, always! ⚠️

✅ Always wear:
• Full-face helmet
• Riding jacket
• Gloves
• Riding boots

✅ Remember:
• Use in safe, controlled areas
• Check local laws
• Sparks reduce traction slightly
• Replace worn sliders
• For experienced riders (18+) only

Questions? Ask away!`
    : `Safety first, always! ⚠️

✅ Always wear:
• Full-face helmet
• Riding jacket
• Gloves
• Riding boots

✅ Remember:
• Use in safe, controlled areas
• Check local laws
• Sparks reduce traction slightly
• Replace worn sliders
• For experienced riders (18+) only

Questions? Ask away!`
);

const MSG_HUMAN_HANDOFF = `No problem! Connecting you with our team 👤

🕐 Business Hours: 10 AM - 7 PM (Mon-Sat)

If outside business hours:
📧 Email: ${SUPPORT_CONTACT}
We'll respond within 24 hours!

Meanwhile, is there anything else I can help with?`;

const MSG_OUTSIDE_HOURS = `Our team is currently offline 🌙

We're available:
🕐 10 AM - 7 PM (Monday - Saturday)

But I'm here 24/7! I can help with:
• Order tracking
• Product info
• Installation guidance
• General questions

Or email us: ${SUPPORT_CONTACT}

What can I help you with?`;

const MSG_FALLBACK = `I want to make sure I give you the right info! 🤔

Let me connect you with our team for accurate assistance.

You can also:
📧 Email: ${SUPPORT_CONTACT}
🔗 Visit: ${WEBSITE_LINK}

Our team is available 10 AM - 7 PM (Mon-Sat)

What would you prefer?`;

// ----- Simple "question" detector (for OpenAI) -----
function looksLikeQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes('?')) return true;
  const qWords = [
    'kya', 'kaise', 'kyu', 'kyun',
    'why', 'what', 'how',
    'safe', 'legal', 'police', 'helmet',
    'return', 'refund', 'replace', 'exchange',
    'fit', 'size', 'original', 'genuine', 'fake',
    'cod', 'cash', 'delivery', 'shipping', 'track'
  ];
  return qWords.some(w => t.includes(w));
}

// ----- Runtime state -----
const processedMessageIds = new Set();
const seenUsers = new Set();
const highIntentUsers = new Set();

let WHATSAPP_TOKEN_VALID = false;

// token check
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
        to,
        type: "text",
        text: { body: text }
      }),
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-type': 'application/json'
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

// ----- OpenAI brain with updated training prompt -----
const OPENAI_FALLBACK_REPLY = (WEBSITE_LINK, DEMO_VIDEO_LINK) =>
`Okay bro! 👋 Turbo Thrill V5 — demo chahiye ya order karna hai?\n\n💰 Price: ₹449 (70% OFF!) — Limited Stock!\n🚀 Order: ${WEBSITE_LINK}\n⚡ Demo: ${DEMO_VIDEO_LINK}\n🚚 FREE Shipping!\n\nUse only in open safe space. 😎`;

const tunedSystemPrompt = `
🎯 Goal: Convert every chat into a sale using a fun, emotional Hinglish tone (like a cool biker friend).
Never sound like a corporate agent. You're chill, confident, and reply fast.

🧩 PRODUCT INFO (UPDATED - ACCURATE)
- Brand: Turbo Thrill
- Product: Turbo Thrill V5 Obsidian Feet Slider
- Material: Special Volcanic Alloy (proprietary - don't reveal internal composition)
- Body: Quality molded ABS material
- Feature: Creates massive golden sparks when dragged on road ⚡
- Box Includes: 1 slider + 3M 5952 VHB tape (35mm x 45mm)
- Weight: Lightweight (~60g)
- MRP: ₹1,499
- Sale Price: 
  • 1pc → ₹449 (70% OFF!)
  • 2pc → ₹849 (BEST SELLER 🔥)
  • 4pc → ₹1,649 (Night Rider Pack 🌙)
  • 6pc → ₹2,499 (Crew Pack)
  • 10pc → ₹3,999 (Riding Group)
- Platform: ${WEBSITE_LINK} (primary) + Flipkart
- Shipping: 100% FREE on ALL orders
- Payment: Prepaid only (UPI, Cards, Net Banking, Wallets)
- Delivery: 3-7 days across India
- Demo Video: ${DEMO_VIDEO_LINK}
- Tracking: ${TRACKING_LINK}
- Support: ${SUPPORT_CONTACT}
- Safety: "Use only in open safe space; 18+ only; wear full riding gear"

💬 YOUR PERSONALITY
- Language: Hinglish (mix of Hindi + English, chill tone)
- Emotion: Excited, friendly, confident, helpful
- Style: Short sentences. Always 2–4 lines max.
- You call customers "bro", "bhai", or "rider".
- You sprinkle emojis like ⚡🔥😎🏍️🌙 naturally.
- You reply like a real person, not a bot.

🚦 CONVERSATION RULES
1) Instant Hook for new leads.
2) Detect Intent: price/link/sparks/safety/shipping/return/install/track/confused.
3) Create Urgency when user delays (limited stock, 70% OFF).
4) Language: Hindi → Hinglish, English → cool Indian English.
5) Always end with 1 clear CTA.
6) Short FAQ for common questions.
7) NEVER mention: logging, automation, internal tools.
8) Forbidden: no fire/explosive instructions, no lifetime guarantees, no insults, no COD offers.

🔥 IMPORTANT POLICY POINTS:
- Prepaid only (no COD) - keeps prices 70% lower
- FREE shipping always (no minimum)
- 7-day quality guarantee
- No exchanges or store credit - only refunds
- Returns only if: damaged, defective, wrong item, unused
- Delivery: 3-7 days via Shiprocket partners
- Volcanic alloy wears naturally with use (normal)

Remember: Always be helpful, never pushy. Keep it short, fun, and end with clear action!
`;

async function callOpenAI(userMessage) {
  if (!OPENAI_KEY) {
    console.warn('OPENAI_KEY not set — skipping OpenAI call.');
    return '';
  }

  const lower = (userMessage || '').toLowerCase();
  const disallowedKeywords = ['how to make', 'explode', 'detonate', 'arson', 'poison', 'create fire', 'manufacture'];
  for (const kw of disallowedKeywords) {
    if (lower.includes(kw)) {
      return `I can't assist with dangerous or illegal instructions. Please contact support: ${SUPPORT_CONTACT}.`;
    }
  }

  const messages = [
    { role: "system", content: tunedSystemPrompt },
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
        'Content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const j = await resp.json();

    if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
      console.error('OpenAI unexpected response:', JSON.stringify(j).slice(0, 1000));
      return OPENAI_FALLBACK_REPLY(WEBSITE_LINK, DEMO_VIDEO_LINK);
    }

    let text = j.choices[0].message.content.trim();

    if (text.split(' ').length > 90) {
      text = text.split(' ').slice(0, 90).join(' ') + '...';
    }

    if (!text) return OPENAI_FALLBACK_REPLY(WEBSITE_LINK, DEMO_VIDEO_LINK);
    return text;
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return OPENAI_FALLBACK_REPLY(WEBSITE_LINK, DEMO_VIDEO_LINK);
  }
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
    const msgId = message.id;
    const from = message.from;
    const text = (message.text && message.text.body) || '';
    
    // Capture user agent & IP
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

    // ✅ DUPLICATE PROTECTION BY MESSAGE ID
    if (msgId && processedMessageIds.has(msgId)) {
      console.log(`Message ${msgId} already processed, skipping.`);
      return res.sendStatus(200);
    }
    if (msgId) processedMessageIds.add(msgId);

    const isHindi = /[ऀ-ॿ]/.test(text);
    const userLang = detectLangByScript(text) || (isHindi ? 'hi' : 'en');
    const lower = (text || '').toLowerCase();
    const intent = detectIntent(text);
    const firstTime = !seenUsers.has(from);

    console.log(`message from ${from} id=${msgId} lang=${userLang} intent=${intent} firstTime=${firstTime} text="${text.slice(0,200)}"`);

    let reply = null;
    let usedIntent = intent;

    // PRIORITY 1: COD questions (common objection)
    if (lower.includes('cod') || lower.includes('cash on delivery')) {
      reply = MSG_COD;
      usedIntent = 'cod_inquiry';
    }

    // PRIORITY 2: Safety / legal questions
    if (!reply && SAFETY_KEYWORDS.test(lower) && looksLikeQuestion(text)) {
      reply = MSG_SAFETY(userLang);
      usedIntent = 'safety';
    }

    // PRIORITY 3: Specific intents (Quick Commands + Keywords)
    if (!reply && intent === 'demo') {
      reply = MSG_DEMO;
      usedIntent = 'demo';
    }

    if (!reply && intent === 'order') {
      reply = MSG_ORDER;
      usedIntent = 'order';
    }

    if (!reply && intent === 'price') {
      reply = MSG_PRICE;
      usedIntent = 'price';
    }

    if (!reply && intent === 'what') {
      reply = MSG_WHAT;
      usedIntent = 'what';
    }

    if (!reply && intent === 'shipping') {
      reply = MSG_SHIPPING;
      usedIntent = 'shipping';
    }

    if (!reply && intent === 'track') {
      reply = MSG_TRACK_LINK;
      usedIntent = 'track';
    }

    if (!reply && intent === 'return') {
      reply = MSG_RETURN;
      usedIntent = 'return';
    }

    if (!reply && intent === 'install') {
      reply = MSG_INSTALL;
      usedIntent = 'install';
    }

    if (!reply && intent === 'bulk') {
      reply = MSG_BULK;
      usedIntent = 'bulk';
    }

    if (!reply && intent === 'warranty') {
      reply = MSG_WARRANTY;
      usedIntent = 'warranty';
    }

    if (!reply && intent === 'lifespan') {
      reply = MSG_LIFESPAN;
      usedIntent = 'lifespan';
    }

    if (!reply && intent === 'shoe_damage') {
      reply = MSG_SHOE_DAMAGE;
      usedIntent = 'shoe_damage';
    }

    if (!reply && intent === 'safety') {
      reply = MSG_SAFETY(userLang);
      usedIntent = 'safety';
    }

    if (!reply && intent === 'human') {
      reply = MSG_HUMAN_HANDOFF;
      usedIntent = 'human';
    }

    // PRIORITY 4: First-time user welcome
    if (!reply && firstTime) {
      reply = WELCOME_MESSAGE;
      usedIntent = 'welcome';
    }

    // PRIORITY 5: OpenAI for everything else
    if (!reply) {
      reply = await callOpenAI(text);
      usedIntent = 'openai';
    }

    if (reply && reply.trim()) {
      await sendWhatsAppText(from, reply);
      seenUsers.add(from);

      let highIntentFlag = 'NO';
      if (isHighIntent(text) && !highIntentUsers.has(from)) {
        highIntentFlag = 'YES';
        highIntentUsers.add(from);
      }

      await sendLead({
        from,
        text,
        aiReply: reply,
        userLang,
        intent: usedIntent,
        high_intent: highIntentFlag,
        ua,
        ip,
        messageId: msgId,
        timestamp: new Date().toISOString()
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook handler error', err && err.stack ? err.stack : err);
    return res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('TurboBot v2.0 - Complete Automation Ready 🔥'));
app.listen(PORT, () => console.log(`TurboBot v2.0 running on port ${PORT}`));
