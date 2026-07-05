FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit
COPY index.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
