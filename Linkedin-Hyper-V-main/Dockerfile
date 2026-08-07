# Next.js Frontend Dockerfile for Render
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Pass dummy environment variables for NEXT_PUBLIC_* at build time
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG NEXT_PUBLIC_WS_URL=ws://localhost:3001
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_TURBOPACK_EXPERIMENTAL_USE_SYSTEM_TLS_CERTS=1

# Build the application (will use placeholders for env vars)
# The actual values come from runtime environment variables
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Create non-root system user & group
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy standalone build with proper ownership
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Start Next.js standalone server
CMD ["node", "server.js"]
