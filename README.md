# 🚀 File Upload Server

A production-ready file upload server with TUS protocol support, Docker, Nginx, and Cloudflare Tunnel integration.

## ✨ Features

- 📦 Large file support (up to 10GB per file)
- 🔄 Resumable uploads (pause and continue anytime)
- 🐳 Docker containerized with Nginx reverse proxy
- 🔒 Secure with Cloudflare Tunnel support
- 💾 Automatic disk space monitoring
- 📊 Health check endpoint
- 🛡️ Rate limiting and security headers
- 📝 Comprehensive logging
- 🔧 Easy configuration via environment variables

## 📋 Prerequisites

- Node.js 18+ (for local development)
- Docker & Docker Compose (for containerized deployment)
- Cloudflare account (optional, for tunnel)

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Install dependencies (for building)
