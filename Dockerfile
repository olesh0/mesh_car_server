FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends libudev1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

ENV HOST=0.0.0.0
ENV PORT=3000
ENV FRONTEND_ORIGIN=http://localhost:5173

EXPOSE 3000

CMD ["node", "index.js"]
