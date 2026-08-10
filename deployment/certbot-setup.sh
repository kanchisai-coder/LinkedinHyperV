#!/bin/bash
# Let's Encrypt SSL Setup Script for LinkedIn Hyper-V
# Run this script with: bash deployment/certbot-setup.sh

set -e

echo "🔒 LinkedIn Hyper-V - SSL Certificate Setup"
echo "==========================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "❌ Please do not run as root. Run as regular user with sudo privileges."
   exit 1
fi

# Get domain and email
read -p "Enter your domain name (e.g., dashboard.example.com): " DOMAIN
read -p "Enter your email for Let's Encrypt notifications: " EMAIL

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo "❌ Domain and email are required"
    exit 1
fi

echo ""
echo "📋 Configuration:"
echo "   Domain: $DOMAIN"
echo "   Email:  $EMAIL"
echo ""
read -p "Continue? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Stop Nginx temporarily
echo ""
echo "⏸️  Stopping Nginx temporarily..."
sudo systemctl stop nginx

# Obtain certificate
echo ""
echo "📜 Obtaining SSL certificate from Let's Encrypt..."
sudo certbot certonly --standalone \
    --preferred-challenges http \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN"

# Copy nginx config
echo ""
echo "📝 Configuring Nginx..."
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
sudo cp "$SCRIPT_DIR/nginx.conf" /etc/nginx/sites-available/linkedin-hyper-v

# Replace domain placeholder
sudo sed -i "s/your-domain.com/$DOMAIN/g" /etc/nginx/sites-available/linkedin-hyper-v

# Enable site
echo "🔗 Enabling Nginx site..."
sudo ln -sf /etc/nginx/sites-available/linkedin-hyper-v /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Create certbot webroot directory
sudo mkdir -p /var/www/certbot

# Test and start Nginx
echo ""
echo "✅ Testing Nginx configuration..."
sudo nginx -t

echo ""
echo "▶️  Starting Nginx..."
sudo systemctl start nginx
sudo systemctl enable nginx

# Setup auto-renewal
echo ""
echo "🔄 Setting up automatic certificate renewal..."
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# Test renewal
echo ""
echo "🧪 Testing certificate renewal (dry run)..."
sudo certbot renew --dry-run

echo ""
echo "✅ SSL setup complete!"
echo ""
echo "================================================"
echo "Your dashboard will be available at:"
echo "   https://$DOMAIN"
echo ""
echo "Certificate auto-renewal is configured via certbot.timer"
echo "Check renewal timer: sudo systemctl status certbot.timer"
echo "================================================"
