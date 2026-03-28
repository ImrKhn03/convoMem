FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN apk add --no-cache openssl
RUN npm install --omit=dev
RUN npx prisma generate

COPY src ./src

EXPOSE 8000

CMD ["node", "src/index.js"]
