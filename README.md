# Living Fractal Prototype

NixOS configuration generator prototype. Takes plain-language system descriptions
and generates complete, documented NixOS configurations via DeepSeek V3 on OpenRouter.

## Deploy to Hetzner VPS

### 1. Copy files to server

```bash
rsync -avz --exclude node_modules ./ user@your-vps:/opt/livingfractal/
```

### 2. Install dependencies

```bash
ssh user@your-vps
cd /opt/livingfractal
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
# Set your OPENROUTER_API_KEY
```

### 4. Set up systemd service

```bash
sudo cp livingfractal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable livingfractal
sudo systemctl start livingfractal
sudo systemctl status livingfractal
```

### 5. Configure Caddy

Add the site block from `Caddyfile.example` to your Caddy configuration,
then reload:

```bash
sudo systemctl reload caddy
```

### 6. Verify

```bash
curl http://localhost:3120/api/health
# Should return: {"status":"ok","model":"deepseek/deepseek-chat-v3-0324"}
```

Then visit https://livingfractal.com

## Local development

```bash
cp .env.example .env
# Edit .env with your OpenRouter key
npm install
npm run dev
# Open http://localhost:3120
```

## Structure

```
server.js              Express backend, proxies to OpenRouter
public/index.html      Frontend interface
livingfractal.service  systemd unit file
Caddyfile.example      Caddy reverse proxy config
.env.example           Environment template
```

## Costs

DeepSeek V3 on OpenRouter: roughly $0.27/M input, $1.10/M output tokens.
A typical generation uses ~1K input + ~3K output tokens, so approximately
$0.004 per generation. At 100 generations/day that's about $0.40/day.
