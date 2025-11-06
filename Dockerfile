# Dockerfile (simple, works without package-lock.json)
FROM node:20-alpine

# create app dir
WORKDIR /app

# copy package.json and install production deps
COPY package.json package-lock.json* ./

# Use npm install and omit dev dependencies. This works even if package-lock.json missing.
RUN npm install --omit=dev

# copy remaining files
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
