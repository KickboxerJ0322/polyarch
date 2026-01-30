FROM node:18-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
ENV NODE_ENV=production

# Cloud RunはPORT環境変数で渡してくる
EXPOSE 8080
CMD ["npm", "start"]
