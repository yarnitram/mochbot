FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/bot.db
RUN apk add --no-cache fontconfig font-dejavu font-noto && fc-cache -f
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY web ./web
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',{headers:process.env.DASHBOARD_PASSWORD?{authorization:'Basic '+Buffer.from('health:'+process.env.DASHBOARD_PASSWORD).toString('base64')}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
