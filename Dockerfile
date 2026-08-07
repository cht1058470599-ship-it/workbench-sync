FROM node:22-alpine
WORKDIR /app
COPY server.js /app/server.js
COPY www/ /www/
ENV PORT=3000
ENV SYNC_TOKEN=""
ENV DATA_FILE=/data/data.json
ENV WWW_DIR=/www
EXPOSE 3000
CMD ["node", "server.js"]
