FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --only=production
RUN npx prisma generate

COPY src ./src

EXPOSE 8000

CMD ["node", "src/index.js"]
