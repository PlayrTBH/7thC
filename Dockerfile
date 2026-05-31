FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache bash docker-cli docker-cli-compose git openssh-client
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY update.sh ./update.sh
RUN chmod +x ./update.sh
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
