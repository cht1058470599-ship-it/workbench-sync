FROM node:22-alpine
WORKDIR /app
COPY server.js /app/server.js
ENV PORT=3000
ENV SYNC_TOKEN=""
ENV DATA_FILE=/data/data.json
EXPOSE 3000
CMD ["node", "server.js"]
