FROM node:20-alpine
WORKDIR /app

# No runtime dependencies, but copy manifest first for layer caching.
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
