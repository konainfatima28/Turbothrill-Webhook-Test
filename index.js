// index.js - TurboThrill webhook (patched for FAQ matching, embeddings fallback, safety, token health)
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
const FLIPKART_LINK = process.env.FLIPKART_LINK || "https://www.flipkart.com/turbo-thrill-v5-obsidian-feet-slider-bikers-riders-1-piece-flint-fire-starter/p/itmec22d01cb0e22";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "https://hook.us2.make.com/6548oa0aurotwx5ws87hrbr9f4ajay7g";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "turbothrill123";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "200", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.45"); // slightly more excited tone
const DEMO_VIDEO_LINK = process.env.DEMO_VIDEO_LINK || "https://www.instagram.com/reel/C6V-j1RyQfk/?igsh=MjlzNDBxeTRrNnlz";
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "Support@turbothrill.in";
const PORT = process.env.PORT || 3000;

// FAQ / Embeddings flags
const USE_EMBEDDINGS = (process.env.USE_EMBEDDINGS || "false").toLowerCase() === "true";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_SIMILARITY_THRESHOLD = parseFloat(process.env.EMBEDDING_SIMILARITY_THRESHOLD || "0.75");

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

// ----- Embedded FAQ knowledge base (English + Hinglish)
const FAQS = [
  {
    id: 1,
    q: "Does Turbo Thrill V5 really produce sparks?",
    a_en: "Yes — when the slider is dragged on rough road surfaces it produces dramatic sparks used for visual effect in demos. Use only in safe, open areas.",
    a_hinglish: "Haan bro — jab slider rough road par ghishta hai toh flashy sparks nikalte hain. Demo ke liye safe, khula area use karna.",
    tags: ["sparks","demo","safety"]
  },
  {
    id: 2,
    q: "Is it safe? Will it start a fire?",
    a_en: "The sparks are visual and not meant to ignite materials. Avoid using near flammable liquids, fuel tanks, or crowds. Always demo on concrete/rough surfaces and keep a safe distance.",
    a_hinglish: "Sparks visual purpose ke liye hain — kisi cheez ko jalane ke liye nahi. Petrol ya aag ke paas nahi use karna. Hamesha open concrete surface par safe distance rakho.",
    tags: ["safety","fire"]
  },
  {
    id: 3,
    q: "What is included in the box?",
    a_en: "You get 1 Feet Slider, 3M VHB tape and Fevikwik for attachment.",
    a_hinglish: "Box me milta hai: 1 feet slider, 3M VHB tape aur Fevikwik.",
    tags: ["box","contents"]
  },
  {
    id: 4,
    q: "How to attach it to shoes?",
    a_en: "Clean the shoe surface, peel the 3M tape, press the slider firmly for 60 seconds and add Fevikwik if needed. Let adhesive cure before riding.",
    a_hinglish: "Shoe saaf karo, tape lagao, 60 sec tak zor se press karo. Fevikwik laga ke set hone do phir use karo.",
    tags: ["installation","howto"]
  },
  {
    id: 5,
    q: "How long does it last?",
    a_en: "Lifetime varies with use — heavy riders will wear it faster. Typical everyday use lasts several weeks to months.",
    a_hinglish: "Use pe depend karta hai — heavy use me jaldi ghis sakta hai, normal use me kuch hafton se months tak chal sakta hai.",
    tags: ["durability","lifetime"]
  },
  {
    id: 6,
    q: "Which shoes or boots is it compatible with?",
    a_en: "Works best on hard-soled riding shoes or boots where you can glue/press the slider. Not recommended for very soft or stretchy materials.",
    a_hinglish: "Hard-soled riding shoes/boots par best kaam karta hai. Soft shoes me theek se chipkega nahi.",
    tags: ["compatibility","shoes"]
  },
  {
    id: 7,
    q: "What material is it made of?",
    a_en: "The Flipkart spec lists the material as 'stone,' while we market the product as made from our proprietary Special Volcanic Alloy for performance. We don't disclose exact composition.",
    a_hinglish: "Flipkart listing me “stone” likha hai; brand ke material ko hum Special Volcanic Alloy bolte hain. Exact formula secret hai.",
    tags: ["material","composition"]
  },
  {
    id: 8,
    q: "Does it come with a striker?",
    a_en: "No — the package does not include a striker or knife. Use the included tape/adhesive for mounting.",
    a_hinglish: "Nahi, striker included nahi hai. Sirf slider + tape + Fevikwik milta hai.",
    tags: ["box","contents"]
  },
  {
    id: 9,
    q: "Is COD available and what is the return policy?",
    a_en: "Flipkart lists Cash on Delivery availability and a 7-day return policy — check the product page at checkout for your pin code.",
    a_hinglish: "Flipkart pe COD available dikh raha hai aur 7 din ki return policy hai — checkout par pin check karo.",
    tags: ["returns","cod","flipkart"]
  },
  {
    id: 10,
    q: "Will it damage my shoe or bike?",
    a_en: "If attached and used correctly it should not damage the shoe. Avoid continuous hard grinding; misuse can wear the sole. Always follow the mounting guide.",
    a_hinglish: "Sahi tarah lagane par shoe damage nahi hoga. Lekin continuous hard grinding se sole ghis sakta hai — instructions follow karo.",
    tags: ["damage","safety"]
  },
  {
    id: 11,
    q: "Can I use it on road traffic?",
    a_en: "No — don't intentionally create sparks in traffic or near pedestrians. Use only in controlled, safe environments.",
    a_hinglish: "Road traffic me intentionally sparks mat karo — public safety pe dhyan do.",
    tags: ["safety","legal"]
  },
  {
    id: 12,
    q: "How heavy is it?",
    a_en: "Approximately 60 g.",
    a_hinglish: "Weight lagbhag 60 g hai.",
    tags: ["weight","specs"]
  },
  {
    id: 13,
    q: "Why are some reviews negative?",
    a_en: "Some users complain about fit, expectations, or early wear. We recommend reading the mounting instructions and testing in a safe demo to set expectations.",
    a_hinglish: "Kuch reviews fit/wear ko lekar negative hain — instructions dhang se follow karo aur demo me check karo.",
    tags: ["reviews","expectations"]
  },
  {
    id: 14,
    q: "Can I get spare sliders?",
    a_en: "Check our Flipkart store for 'other sellers' or reorder from the same listing (Pack of 1 currently). You can contact the seller via Flipkart for spare parts.",
    a_hinglish: "Flipkart store ya same listing se spare dekh lo; seller se bhi contact kar sakte ho.",
    tags: ["spare","purchase"]
  },
  {
    id: 15,
    q: "Is there any maintenance?",
    a_en: "Wipe with a dry cloth after use; avoid water immersion. Reapply adhesive if loosened.",
    a_hinglish: "Use ke baad dry cloth se wipe karo; water me doobo mat. Agar loose ho toh dubara glue karo.",
    tags: ["maintenance","care"]
  }
];

// Precomputed embeddings cache for FAQ (populated if USE_EMBEDDINGS)
let faqEmbeddings = null;

// ----- Utility: cosine similarity
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function magnitude(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}
function cosineSim(a, b) {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

// ----- Embeddings functions (optional, used when USE_EMBEDDINGS=true)
async function fetchEmbedding(text) {
  if (!OPENAI_KEY) throw new Error('OPENAI_KEY missing for embeddings');
  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text })
    });
    const j = await resp.json();
    if (j && j.data && j.data[0] && j.data[0].embedding) {
      return j.data[0].embedding;
    } else {
      console.error('Embedding response unexpected:', JSON.stringify(j).slice(0,1000));
      return null;
    }
  } catch (e) {
    console.error('Embedding request failed:', e && e.message ? e.message : e);
    return null;
  }
}

async function prepareFaqEmbeddings() {
  if (!USE_EMBEDDINGS) return;
  if (!OPENAI_KEY) {
    console.warn('USE_EMBEDDINGS is true but OPENAI_KEY is not set. Skipping embeddings preparation.');
    return;
  }
  try {
    console.log('Preparing FAQ embeddings (this may take a few seconds)...');
    const promises = FAQS.map(f => fetchEmbedding(f.q));
    const results = await Promise.all(promises);
    faqEmbeddings = results.map((emb, idx) => ({ emb, id: FAQS[idx].id }));
    console.log('FAQ embeddings prepared for', faqEmbeddings.filter(x => x.emb).length, 'items');
  } catch (e) {
    console.error('prepareFaqEmbeddings error:', e && e.message ? e.message : e);
    faqEmbeddings = null;
  }
}
// prepare at startup if enabled (non-blocking)
if (USE_EMBEDDINGS) {
  prepareFaqEmbeddings().catch(e => console.error('prepareFaqEmbeddings caught', e));
}

// ----- FAQ matching: exact/keyword + optional embeddings fallback
function keywordsForFaq(faq) {
  // derive a simple keyword set: split q and tags
  const qkeys = (faq.q || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const tagkeys = (faq.tags || []).map(t => t.toLowerCase());
  return Array.from(new Set([...qkeys, ...tagkeys]));
}

function simpleMatchFAQ(text) {
  if (!text || text.trim().length === 0) return null;
  const t = text.toLowerCase();
  for (const f of FAQS) {
    // exact phrase match on question
    if (t.includes(f.q.toLowerCase().replace(/\?/g, '').trim())) {
      return f;
    }
    // keyword partial match: require 2 keywords to be present to reduce false positives
    const keys = keywordsForFaq(f).filter(k => k.length > 2);
    let matched = 0;
    for (const k of keys) {
      if (t.includes(k)) matched++;
      if (matched >= 2) return f;
    }
  }
  return null;
}

async function fuzzyMatchFAQWithEmbeddings(text) {
  if (!USE_EMBEDDINGS) return null;
  if (!faqEmbeddings || faqEmbeddings.length === 0) {
    // attempt to prepare on-demand
    await prepareFaqEmbeddings();
  }
  if (!faqEmbeddings) return null;
  const embed = await fetchEmbedding(text);
  if (!embed) return null;
  let best = { id: null, score: -1 };
  for (const fe of faqEmbeddings) {
    if (!fe.emb) continue;
    const s = cosineSim(embed, fe.emb);
    if (s > best.score) {
      best = { id: fe.id, score: s };
    }
  }
  if (best.id && best.score >= EMBEDDING_SIMILARITY_THRESHOLD) {
    return FAQS.find(f => f.id === best.id) || null;
  }
  return null;
}

async function matchFAQ(text, isHindi) {
  // 1) try simple deterministic checks
  const simple = simpleMatchFAQ(text);
  if (simple) return { faq: simple, method: 'simple', score: 1.0 };

  // 2) optional embeddings fallback
  if (USE_EMBEDDINGS && OPENAI_KEY) {
    try {
      const fuzzy = await fuzzyMatchFAQWithEmbeddings(text);
      if (fuzzy) return { faq: fuzzy, method: 'embeddings', score: 0.0 /*score not passed through*/ };
    } catch (e) {
      console.error('matchFAQ embeddings error:', e && e.message ? e.message : e);
    }
  }

  // no match
  return null;
}

// ----- Tuned system prompt + language-aware OpenAI call -----
const OPENAI_FALLBACK_REPLY = `
You are TurboBot — the official AI sales assistant for Turbo Thrill.
`;

const tunedSystemPrompt = `
You are TurboBot — the official AI sales assistant for Turbo Thrill.

Your mission: convert leads into buyers on Flipkart using powerful emotional, fun, Hinglish-driven messages.
Tone: confident, friendly, Indian rider vibe. Short sentences. Smart emojis.
Personality: like a cool biker bro who knows his gear. Never pushy, always smooth.

Key info:
- Product: Turbo Thrill V5 Obsidian Feet Slider
- Material: Special Volcanic Alloy
- Unique Feature: produces MASSIVE SPARKS when sliding on road ⚡ (used for demo thrill)
- Selling platform: Flipkart (use the provided link)
- Price range: ₹498–₹599
- Always reassure quality + Flipkart trust + fast delivery.
- Use Hindi, Hinglish, or English based on user input.
- If user sounds unsure, use curiosity ("Want to see the sparks demo? 👀")
- If user asks "How it works", explain in thrill tone, not technical.
- Never give dangerous instructions. Say: “For safety, always test in open space”.
- End replies with one call-to-action (Flipkart link, demo video, or a fun emoji).


Short message format (3–4 lines max).

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

    // Post-processing rules:
    // Replace placeholder bracket links if present
    text = text.replace(/\[Watch Demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);
    text = text.replace(/\[watch demo\]\([^)]+\)/ig, DEMO_VIDEO_LINK);

    // Trim length (safety)
    if (text.split(' ').length > 90) {
      text = text.split(' ').slice(0, 90).join(' ') + '...';
    }

    if (!text) return OPENAI_FALLBACK_REPLY;
    return text;
  } catch (e) {
    console.error('OpenAI call failed:', e && e.message ? e.message : e);
    return OPENAI_FALLBACK_REPLY;
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

    console.log(`message from ${from} lang=${userLang} text="${(text||'').slice(0,200)}"`);

    // ===== dedupe check - inside async handler (safe to await) =====
    const intent = detectIntent(text);
    if (shouldSkipDuplicate(from, intent, text)) {
      console.log(`Skipping duplicate ${intent} from ${from}`);
      await sendWhatsAppText(from, "I just sent that — did you get the demo? Reply YES if you didn't.");
      return res.sendStatus(200);
    }

    // ===== FAQ matching (first) =====
    let botAnswerType = 'AI'; // default
    let aiReply = '';
    try {
      const faqMatch = await matchFAQ(text, isHindi);
      if (faqMatch && faqMatch.faq) {
        const f = faqMatch.faq;
        aiReply = isHindi ? f.a_hinglish : f.a_en;
        botAnswerType = 'FAQ';
        console.log(`FAQ matched (method=${faqMatch.method}) -> faq id=${f.id}`);
      } else {
        // No FAQ match: continue to OpenAI
        aiReply = await callOpenAI(text, userLang);
        botAnswerType = 'AI';
      }
    } catch (e) {
      console.error('FAQ matching error (continuing to OpenAI):', e && e.message ? e.message : e);
      aiReply = await callOpenAI(text, userLang);
      botAnswerType = 'AI';
    }

    // If AI didn't produce anything, fallback
    if (!aiReply || !aiReply.trim()) {
      aiReply = `Hey — thanks for your message! Want the Flipkart link? ${FLIPKART_LINK}${DEMO_VIDEO_LINK ? ` Or watch a quick demo: ${DEMO_VIDEO_LINK}` : ''}`;
    }

    // If the user intent is BUY but reply didn't include Flipkart link, append it
    if (intent === 'buy' && !aiReply.toLowerCase().includes('flipkart')) {
      aiReply = `${aiReply}\n\nBuy here: ${FLIPKART_LINK}`;
    }

    // attempt send (this is guarded inside sendWhatsAppText)
    await sendWhatsAppText(from, aiReply);

    // forward to Make (optional) with botAnswerType for analytics
    if (MAKE_WEBHOOK_URL) {
      try {
        await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ from, text, aiReply, userLang, timestamp: new Date().toISOString(), botAnswerType })
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
