#!/bin/bash
# Ubuntu 24.04 LTS Server Setup Script for LinkedIn Hyper-V
# Run this script with: bash deployment/ubuntu-setup.sh

set -e

echo "🚀 LinkedIn Hyper-V - Ubuntu 24.04 Setup"
echo "========================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "❌ Please do not run as root. Run as regular user with sudo privileges."
   exit 1
fi

# Update system
echo ""
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Docker
echo ""
echo "🐳 Installing Docker..."
if ! command -v docker &> /dev/null; then
    sudo apt install -y docker.io docker-compose-v2
    sudo systemctl enable docker
    sudo systemctl start docker
    sudo usermod -aG docker $USER
    echo "✅ Docker installed"
else
    echo "✅ Docker already installed"
fi

# Install Nginx
echo ""
echo "🌐 Installing Nginx..."
if ! command -v nginx &> /dev/null; then
    sudo apt install -y nginx
    sudo systemctl enable nginx
    sudo systemctl start nginx
    echo "✅ Nginx installed"
else
    echo "✅ Nginx already installed"
fi

# Install Certbot for Let's Encrypt
echo ""
echo "🔒 Installing Certbot..."
if ! command -v certbot &> /dev/null; then
    sudo apt install -y certbot python3-certbot-nginx
    echo "✅ Certbot installed"
else
    echo "✅ Certbot already installed"
fi

# Install Git
echo ""
echo "📥 Installing Git..."
if ! command -v git &> /dev/null; then
    sudo apt install -y git
    echo "✅ Git installed"
else
    echo "✅ Git already installed"
fi

# Create project directory
echo ""
echo "📁 Creating project directory..."
PROJECT_DIR="$HOME/linkedin-hyper-v"
if [ ! -d "$PROJECT_DIR" ]; then
    mkdir -p "$PROJECT_DIR"
    echo "✅ Created $PROJECT_DIR"
else
    echo "✅ Directory already exists: $PROJECT_DIR"
fi

# Configure firewall
echo ""
echo "🔥 Configuring firewall..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp comment 'SSH'
    sudo ufw allow 80/tcp comment 'HTTP'
    sudo ufw allow 443/tcp comment 'HTTPS'
    echo "✅ Firewall rules configured (run 'sudo ufw enable' to activate)"
else
    echo "⚠️  UFW not installed, skipping firewall configuration"
fi

echo ""
echo "✅ Server setup complete!"
echo ""
echo "================================================"
echo "Next steps:"
echo "================================================"
echo "1. Log out and log back in (for Docker group permissions)"
echo "2. Clone your repository:"
echo "   cd $PROJECT_DIR"
echo "   git clone <your-repo-url> ."
echo ""
echo "3. Copy and configure environment:"
echo "   cp env.example .env"
echo "   nano .env"
echo ""
echo "4. Generate secrets:"
echo "   DASHBOARD_PASSWORD=\$(openssl rand -base64 32)"
echo "   JWT_SECRET=\$(openssl rand -base64 48)"
echo "   SESSION_ENCRYPTION_KEY=\$(openssl rand -hex 32)"
echo "   API_SECRET=\$(openssl rand -hex 24)"
echo "   REDIS_PASSWORD=\$(openssl rand -hex 16)"
echo ""
echo "5. Set up SSL:"
echo "   bash deployment/certbot-setup.sh"
echo ""
echo "6. Deploy:"
echo "   docker-compose up -d --build"
echo ""
echo "7. Verify:"
echo "   bash deployment/healthcheck.sh"
echo "================================================"
