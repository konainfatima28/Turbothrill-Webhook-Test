#!/bin/bash
# Simple test script for TurboThrill webhook
RENDER_URL="https://turbothrill-webhook-test.onrender.com"
PHONE="918506058213"

echo "Testing TurboThrill webhook on $RENDER_URL"
curl -X POST "$RENDER_URL/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "entry":[{"changes":[{"value":{"messages":[{"from":"'"$PHONE"'","text":{"body":"Hello Turbo Thrill bot!"}}]}}]}]}'
'
