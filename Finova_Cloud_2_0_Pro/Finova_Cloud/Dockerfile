FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY schema.sql ./schema.sql
COPY public/index.html ./public/index.html
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
