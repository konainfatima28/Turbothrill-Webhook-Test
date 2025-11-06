# WhatsApp Cloud API Webhook Receiver (Node.js + Express)

## Overview
This small server implements:
- GET /webhook — verification endpoint (Meta will call this during configuration)
- POST /webhook — receives webhook events (with signature verification)
- Optional helper to send messages using WhatsApp Cloud API

**Important**: Callback URL must be HTTPS (valid SSL) and publicly reachable.

## Included files
- server.js
- package.json
- .env
- Procfile
- Dockerfile
- README.md

## .env (pre-filled values)
- VERIFY_TOKEN is set to: turbothrill123
- BASE_URL is set to: https://test-nrko.onrender.com
Replace `APP_SECRET`, `ACCESS_TOKEN`, and `PHONE_NUMBER_ID` with your real values.

## Steps to deploy
1. Fill `.env` with:
   - VERIFY_TOKEN (already set)
   - APP_SECRET (your Meta App secret)
   - ACCESS_TOKEN (WhatsApp access token)
   - PHONE_NUMBER_ID (your WhatsApp phone number id)
   - PORT, BASE_URL (optional)

2. Deploy to Render / Heroku / Vercel / any host with HTTPS. Example callback URL:
   `https://test-nrko.onrender.com/webhook`

3. In your Meta App Dashboard → **Webhooks**:
   - Add subscription
   - Callback URL: `https://test-nrko.onrender.com/webhook`
   - Verify token: `turbothrill123`
   Meta will perform a GET request to validate; the server must respond with the `hub.challenge` text.

4. Test: use the WhatsApp Cloud API “Send message” or the “Test webhook” flow in Meta dashboard to trigger a POST. Check logs for payloads.

## Notes
- Meta requires HTTPS. If testing locally, use ngrok/localtunnel to expose HTTPS.
- If you set APP_SECRET, the server will validate `x-hub-signature-256`. Keep APP_SECRET secret.
- Respond quickly (200 OK) to webhook POSTs to avoid retries.
