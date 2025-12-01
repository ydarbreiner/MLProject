FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with increased memory
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Expose port
EXPOSE 4200

# Start development server with explicit proxy configuration
CMD ["npx", "ng", "serve", "--host", "0.0.0.0", "--poll", "2000", "--proxy-config", "proxy.conf.json"]