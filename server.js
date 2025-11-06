// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const axios = require('axios');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET; // used to validate signature
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; // optional: to send messages

// Use raw body for signature verification. We'll parse JSON ourselves afterwards.
app.use(morgan('dev'));
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    // attach raw body for signature verification
    req.rawBody = buf;
  }
}));

// Health check
app.get('/', (req, res) => res.send('WhatsApp webhook server is running'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      console.warn('WEBHOOK verification failed. Tokens do not match.');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

function verifySignature(req) {
  const signature = req.header('x-hub-signature-256') || '';
  if (!APP_SECRET) {
    console.warn('APP_SECRET not set - skipping signature verification (not recommended)');
    return true;
  }
  if (!signature.startsWith('sha256=')) return false;
  const expected = signature.replace('sha256=', '');
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody || '');
  const digest = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

app.post('/webhook', (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.warn('Invalid signature on webhook POST');
      return res.sendStatus(401);
    }
  } catch (e) {
    console.error('Error verifying signature', e);
    return res.sendStatus(500);
  }

  const body = req.body;
  // respond quickly
  res.sendStatus(200);

  try {
    console.log('Webhook payload:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          if (value.messages) {
            for (const msg of value.messages) {
              const from = msg.from;
              const text = msg.text && msg.text.body;
              console.log(`Incoming message from ${from}: ${text}`);
              // place your business logic here
            }
          }
        }
      }
    } else {
      console.log('Received non-whatsapp_business_account webhook object:', body.object);
    }
  } catch (err) {
    console.error('Error processing webhook body:', err);
  }
});

async function sendTextMessage(toPhoneNumber, messageText) {
  if (!ACCESS_TOKEN) {
    console.warn('ACCESS_TOKEN not set. Cannot send message.');
    return;
  }
  const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
  if (!PHONE_NUMBER_ID) {
    console.warn('PHONE_NUMBER_ID not set in env. Cannot send message.');
    return;
  }

  const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: toPhoneNumber,
    type: 'text',
    text: { body: messageText }
  };

  try {
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Message sent response:', r.data);
  } catch (err) {
    console.error('Error sending message:', err.response ? err.response.data : err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
