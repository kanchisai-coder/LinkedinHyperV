FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install real Google Chrome Stable (not Chromium)
RUN apt-get update && apt-get install -y wget gnupg \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
     >> /etc/apt/sources.list.d/google.list \
  && apt-get update && apt-get install -y google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# Xvfb + noVNC bridge for visible login sessions in Docker
RUN apt-get update && apt-get install -y xvfb x11-utils x11vnc novnc websockify \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

# Prisma client must be generated inside the image.
COPY prisma/ ./prisma/
COPY prisma.config.ts ./prisma.config.ts
RUN npx prisma generate --schema=prisma/schema.prisma

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

COPY src/ ./src/

# Change ownership of working directory to non-root pwuser
RUN chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3001 6080

ENTRYPOINT ["./entrypoint.sh"]
