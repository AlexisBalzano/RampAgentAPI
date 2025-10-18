# RampAgent API - Docker Deployment

## Quick Start with Docker Compose

### 1. Build and Run
```powershell
# Build and start both Redis and API
docker-compose up --build

# Or run in detached mode (background)
docker-compose up -d --build
```

### 2. Check Status
```powershell
# View running containers
docker-compose ps

# View logs
docker-compose logs -f api
docker-compose logs -f redis
```

### 3. Stop Services
```powershell
# Stop containers
docker-compose down

# Stop and remove volumes (clears Redis data)
docker-compose down -v
```

---

## Testing Individual Components

### Build Docker Image Only
```powershell
docker build -t rampagent-api .
```

### Run API Without Redis
```powershell
docker run -p 3000:3000 -v ${PWD}/data:/app/data:ro rampagent-api
```

### Run with Existing Redis
```powershell
# Start Redis first
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Run API connected to Redis
docker run -p 3000:3000 --link redis:redis -e REDIS_HOST=redis rampagent-api
```

---

## Access Your API

Once running, access:
- **API**: http://localhost:3000
- **Viewer**: http://localhost:3000/debug
- **API Endpoints**: http://localhost:3000/api/...

---

## Environment Variables

You can customize with environment variables:

```yaml
environment:
  - NODE_ENV=production
  - REDIS_HOST=redis
  - REDIS_PORT=6379
  - REDIS_PASSWORD=your-password  # if needed
```

---

## Production Deployment

### Deploy to Cloud (AWS, Azure, GCP)
1. Push your Docker image to a registry:
   ```powershell
   docker tag rampagent-api your-registry/rampagent-api:latest
   docker push your-registry/rampagent-api:latest
   ```

2. Use the cloud provider's container service:
   - **AWS**: ECS, Fargate, or EC2 with Docker
   - **Azure**: Container Instances or App Service
   - **GCP**: Cloud Run or Kubernetes Engine

### Deploy to VPS (DigitalOcean, Linode, etc.)
1. Copy files to your server:
   ```bash
   scp -r . user@your-server:/path/to/app
   ```

2. On the server:
   ```bash
   cd /path/to/app
   docker-compose up -d
   ```

---

## Troubleshooting

### Check if containers are running
```powershell
docker-compose ps
```

### View detailed logs
```powershell
docker-compose logs -f
```

### Restart services
```powershell
docker-compose restart
```

### Rebuild after code changes
```powershell
docker-compose up --build
```

### Access container shell
```powershell
docker-compose exec api sh
```

---

## What's Included

- ✅ Node.js 20 LTS (Alpine Linux - minimal image)
- ✅ Redis 7 with data persistence
- ✅ Automatic health checks
- ✅ Auto-restart on failure
- ✅ Volume mounts for data and logs
- ✅ Production-ready configuration

Your API will work exactly as it does locally, but in a containerized environment!
