# --- Base image ---
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm install --production

# Copy the rest of the project
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "index.js"]