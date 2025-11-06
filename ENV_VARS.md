ENVIRONMENT VARIABLES (use these names exactly):

# Required (must set)
WHATSAPP_TOKEN    - WhatsApp Cloud API Bearer token (example: EAAX... )
PHONE_ID          - WhatsApp Phone Number ID (numeric)
OPENAI_KEY        - OpenAI API key (sk-... )

# Defaults are included in code, but set them explicitly in Render for clarity
FLIPKART_LINK     - https://www.flipkart.com/your-product?utm_source=whatsapp...
MAKE_WEBHOOK_URL  - https://hook.us2.make.com/xxxxxx  (optional)
VERIFY_TOKEN      - webhook verification token you will set in Meta (example: turbothrill123)

# Optional overrides (set to change behavior)
OPENAI_MODEL      - gpt-4o-mini (or gpt-3.5-turbo for cheaper testing)
MAX_TOKENS        - 200
TEMPERATURE       - 0.25
DEMO_VIDEO_LINK   - https://youtu.be/xxx or Instagram reel link
SUPPORT_CONTACT   - +919xxxxxxxxx (human support contact)
PORT              - optional, default 3000
