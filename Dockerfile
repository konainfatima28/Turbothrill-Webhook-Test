# Dockerfile (simple, works without package-lock.json)
# Use official Node.js image
FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
