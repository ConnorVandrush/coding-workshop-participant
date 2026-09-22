#!/usr/bin/env bash
# Script: Comprehensive Local Development Environment Startup
# Purpose: Validate and start all components (MongoDB, LocalStack, Backend, Frontend)
# Usage: ./start-dev.sh

set -e

# Usage helper
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0"
    echo "Start comprehensive local development environment"
    echo ""
    echo "Description:"
    echo "  Validates and starts all required services:"
    echo "  1. PostgreSQL (with proper binding)"
    echo "  2. MongoDB (with proper binding)"
    echo "  3. LocalStack (AWS services emulation)"
    echo "  4. Backend infrastructure (Terraform + Lambda)"
    echo "  5. Frontend development server (React)"
    echo ""
    echo "Options:"
    echo "  -h, --help      Show this help message"
    echo ""
    echo "Requirements:"
    echo "  - postgres installed"
    echo "  - mongod installed"
    echo "  - npm installed"
    echo "  - localstack installed"
    exit 0
fi

echo "==================================================="
echo "Comprehensive Local Development Environment Startup"
echo "==================================================="
echo ""

# Resolve script directory and project root paths
SCRIPT_DIR="$(cd "$(dirname "$0")" > /dev/null 2>&1 || exit 1; pwd -P)"
PROJECT_ROOT="$(cd $SCRIPT_DIR/.. > /dev/null 2>&1 || exit 1; pwd -P)"

# Define project directories
INFRA_DIR="$PROJECT_ROOT/infra"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

# Ensure local development
export AWS_ENDPOINT_URL="http://localhost.localstack.cloud:4566"
export AWS_ENDPOINT_URL_S3="http://s3.localhost.localstack.cloud:4566"

# ============================================================
# STEP 1: Check and Start PostgreSQL
# ============================================================
echo -e "[1/5] Checking PostgreSQL..."

# Lambda functions run inside Docker containers, so they reach the database at
# the Docker bridge address, not on loopback. This must match the value of
# TF_VAR_aws_postgres_host exported in STEP 4.
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PG_BRIDGE_HOST="172.17.0.1"
else
    PG_BRIDGE_HOST="host.docker.internal"
fi

PG_CONTAINER="coding-workshop-postgres"
PG_OK=false

# Already reachable on the address the Lambda containers use? Nothing to do.
if PGCONNECT_TIMEOUT=3 pg_isready -q -h "$PG_BRIDGE_HOST" -p 5432 2>/dev/null; then
    PG_OK=true
    echo -e "  ✓ PostgreSQL reachable on ${PG_BRIDGE_HOST}:5432"
fi

if [ "$PG_OK" = false ]; then
    # Run PostgreSQL in a container rather than rebinding the system server.
    # Editing postgresql.conf/pg_hba.conf and restarting the service needs sudo,
    # which makes the script unusable wherever a password prompt cannot be
    # answered. Binding to the bridge address specifically (rather than 0.0.0.0)
    # also avoids clashing with a system PostgreSQL already on 127.0.0.1:5432.
    docker info > /dev/null 2>&1 || {
        echo -e "  ✗ Docker is not running. Please start Docker and try again."
        exit 1
    }

    if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
        echo -e "  ⚠ PostgreSQL not reachable, restarting container '${PG_CONTAINER}'..."
        docker start "$PG_CONTAINER" > /dev/null 2>&1 || {
            echo -e "  ✗ Failed to start the PostgreSQL container"; exit 1; }
    else
        echo -e "  ⚠ PostgreSQL not reachable on ${PG_BRIDGE_HOST}:5432, starting a container..."
        # Credentials must match the local branch of local.env_vars in
        # infra/locals.tf, which is what gets injected into each Lambda.
        docker run -d --name "$PG_CONTAINER" \
            -e POSTGRES_USER=postgres \
            -e POSTGRES_PASSWORD=postgres123 \
            -e POSTGRES_DB=postgres \
            -p "${PG_BRIDGE_HOST}:5432:5432" \
            postgres:17-alpine > /dev/null || {
                echo -e "  ✗ Failed to create the PostgreSQL container"; exit 1; }
    fi

    # Wait for the server to accept connections
    for i in {1..30}; do
        if PGCONNECT_TIMEOUT=3 pg_isready -q -h "$PG_BRIDGE_HOST" -p 5432 2>/dev/null; then
            echo -e "  ✓ PostgreSQL ready on ${PG_BRIDGE_HOST}:5432"
            break
        fi
        if [ "$i" -eq 30 ]; then
            echo -e "  ✗ PostgreSQL failed to become ready within 30 seconds"
            docker logs --tail 20 "$PG_CONTAINER" 2>&1 | sed 's/^/    /'
            exit 1
        fi
        sleep 1
    done
fi

echo ""

# ============================================================
# STEP 2: Check and Start MongoDB
# ============================================================
echo -e "[2/5] Checking MongoDB..."

# Run the whole check in a subshell so that its `exit 1` paths end the
# subshell rather than the script: MongoDB is optional here. No service under
# backend/ uses it, and infra/variable.tf defaults aws_mongo_enabled to false,
# so an unavailable MongoDB must not block local development. Starting it also
# needs privileges on a fresh machine (/var/lib/mongodb is root-owned).
(

# Check if mongod is installed
if ! command -v mongod &> /dev/null; then
    echo -e "ERROR: MongoDB (mongod) is not installed"
    echo "Install: apt-get install mongodb (Linux) or brew tap mongodb/brew && brew install mongodb-community (Mac)"
    exit 1
fi

# Check if MongoDB is running and properly bound
MONGODB_OK=false

if pgrep -x "mongod" > /dev/null; then
    # MongoDB process exists, check binding
    if command -v ss &> /dev/null; then
        # Use ss (works without sudo on Linux)
        if ss -ltn | grep -q '0.0.0.0:27017'; then
            MONGODB_OK=true
        fi
    elif command -v netstat &> /dev/null && [[ "$(uname)" != "Darwin" ]]; then
        # Fall back to netstat (Linux only - macOS netstat has different output format)
        if netstat -ltn 2>/dev/null | grep -q '0.0.0.0:27017'; then
            MONGODB_OK=true
        fi
    fi

    # On macOS or if above checks failed, check process arguments for bind_ip
    if [ "$MONGODB_OK" = false ]; then
        if ps -p $(pgrep -x "mongod") -o args= 2>/dev/null | grep -q "bind_ip 0.0.0.0\|bind_ip=0.0.0.0"; then
            MONGODB_OK=true
        fi
    fi

    # Final fallback: try to connect directly
    if [ "$MONGODB_OK" = false ]; then
        if mongosh --quiet --eval "db.adminCommand({ping:1}).ok" > /dev/null 2>&1; then
            MONGODB_OK=true
        fi
    fi
fi

if [ "$MONGODB_OK" = true ]; then
    echo -e "  ✓ MongoDB is running and bound to 0.0.0.0:27017"

    # Verify it's actually accessible
    if ! mongosh --quiet --eval "db.adminCommand({ping:1}).ok" > /dev/null 2>&1; then
        echo -e "  ✗ MongoDB is running but not responding to ping"
        exit 1
    fi
    echo -e "  ✓ MongoDB connection verified"
else
    echo -e "  ⚠ MongoDB not running or not bound to 0.0.0.0, starting it..."

    # Kill any existing mongod that's not properly configured
    if pgrep -x "mongod" > /dev/null; then
        echo -e "  ⚠ Stopping misconfigured MongoDB..."
        PID=$(pgrep -x "mongod" || true)
        if [ -n "$PID" ]; then
            OWNER=$(ps -o user= -p "$PID" | tr -d ' ')
            if [ "$OWNER" != "$(whoami)" ]; then
                echo -e "    MongoDB is running as ${OWNER}, attempting sudo stop..."
                if command -v systemctl &> /dev/null && systemctl list-units --type=service --all | grep -q mongod; then
                    sudo systemctl stop mongod || true
                else
                    sudo kill "$PID" || true
                fi
            else
                kill "$PID" || true
            fi
            sleep 2
        fi
    fi

    # Determine data and log directories based on OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        DATA_DIR="/var/lib/mongodb"
        LOG_DIR="/var/log/mongodb"
        # Try to create directories with sudo if needed
        if [ ! -d "$DATA_DIR" ]; then
            mkdir -p "$DATA_DIR" 2>/dev/null || sudo mkdir -p "$DATA_DIR"
        fi
        if [ ! -d "$LOG_DIR" ]; then
            mkdir -p "$LOG_DIR" 2>/dev/null || sudo mkdir -p "$LOG_DIR"
        fi
        # Ensure current user owns the directories
        sudo chown -R $(whoami):$(whoami) "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
    else
        # Mac
        DATA_DIR="/usr/local/var/mongodb"
        LOG_DIR="/usr/local/var/log/mongodb"
        mkdir -p "$DATA_DIR" "$LOG_DIR"
    fi

    # Start MongoDB with correct binding
    echo -e "  Starting MongoDB with --bind_ip 0.0.0.0..."
    mongod --dbpath "$DATA_DIR" --bind_ip 0.0.0.0 --port 27017 --fork --logpath "$LOG_DIR/mongo.log"
    sleep 3

    # Verify it started correctly
    if ! mongosh --quiet --eval "db.adminCommand({ping:1}).ok" > /dev/null 2>&1; then
        echo -e "  ✗ MongoDB failed to start properly"
        echo -e "  Log tail:"
        tail -n 20 "$LOG_DIR/mongo.log" | sed 's/^/    /'
        exit 1
    fi

    echo -e "  ✓ MongoDB started and verified"
fi

) || echo -e "  ⚠ MongoDB unavailable - continuing (no service in this project uses it)"

echo ""

# ============================================================
# STEP 3: Check and Start LocalStack
# ============================================================
echo -e "[3/5] Checking LocalStack..."

# Check if localstack is installed
if ! command -v localstack &> /dev/null; then
    echo -e "ERROR: LocalStack is not installed"
    echo "Install: pip install localstack"
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "ERROR: Docker is not running"
    echo "  Please start Docker Desktop and try again"
    exit 1
fi
echo -e "  ✓ Docker is running"

# Check if LocalStack is running
LOCALSTACK_OK=false
LOCALSTACK_IMAGE="${LOCALSTACK_IMAGE:-localstack/localstack-pro}"
if curl -s http://localhost.localstack.cloud:4566/_localstack/health > /dev/null 2>&1; then
    # Verify the correct image is running
    RUNNING_IMAGE=$(docker inspect localstack-main --format '{{.Config.Image}}' 2>/dev/null || echo "")
    if [ "$RUNNING_IMAGE" != "$LOCALSTACK_IMAGE" ]; then
        echo -e "  ⚠ LocalStack running with wrong image ($RUNNING_IMAGE), expected $LOCALSTACK_IMAGE. Restarting..."
        localstack stop
        docker stop localstack-main 2>/dev/null || true
        sleep 5
    else
        LOCALSTACK_OK=true
        echo -e "  ✓ LocalStack is running ($LOCALSTACK_IMAGE)"
    fi
fi

if [ "$LOCALSTACK_OK" = false ]; then
    # Check if LocalStack docker container is already running
    if docker ps | grep -q localstack-main; then
        echo -e "  ⚠ Stopping existing LocalStack container..."
        localstack stop || echo "WARN: localstack stop didn't work"
        docker stop localstack-main || echo "WARN: docker stop localstack-main didn't work"
        sleep 10
    fi

    echo -e "  ⚠ LocalStack not running, starting it..."
    localstack start -d

    # Wait for LocalStack to be ready (up to 30 seconds)
    for i in {1..30}; do
        if curl -s http://localhost.localstack.cloud:4566/_localstack/health > /dev/null 2>&1; then
            LOCALSTACK_OK=true
            echo -e "  ✓ LocalStack started"
            break
        fi
        echo -e "  Waiting for LocalStack... ($i/30)"
        sleep 1
    done

    if [ "$LOCALSTACK_OK" = false ]; then
        echo -e "  ✗ LocalStack failed to start within 30 seconds"
        exit 1
    fi
fi

# Verify LocalStack services
HEALTH=$(curl -s http://localhost.localstack.cloud:4566/_localstack/health 2>/dev/null || echo "{}")
LAMBDA_STATUS=$(echo "$HEALTH" | grep -o '"lambda":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
S3_STATUS=$(echo "$HEALTH" | grep -o '"s3":"[^"]*"' | cut -d'"' -f4 || echo "unknown")

if [ "$LAMBDA_STATUS" != "available" ] && [ "$LAMBDA_STATUS" != "running" ]; then
    echo -e "  ⚠ Lambda service status: $LAMBDA_STATUS"
fi

if [ "$S3_STATUS" != "available" ] && [ "$S3_STATUS" != "running" ]; then
    echo -e "  ⚠ S3 service status: $S3_STATUS"
fi

echo -e "  ✓ LocalStack services verified"
echo ""

# ============================================================
# STEP 4: Check and Deploy Backend
# ============================================================
echo -e "[4/5] Checking Backend Infrastructure..."

# Detect MongoDB host for LocalStack Lambda functions
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    export TF_VAR_aws_mongo_host="172.17.0.1"
    export TF_VAR_aws_postgres_host="172.17.0.1"
    echo -e "  Detected Linux - using host: 172.17.0.1"
else
    export TF_VAR_aws_mongo_host="host.docker.internal"
    export TF_VAR_aws_postgres_host="host.docker.internal"
    echo -e "  Detected Mac/Windows - using host: host.docker.internal"
fi

# Install pip requirements into each Python service directory for hot-reload
# Skip if requirements.txt hasn't changed since last install (avoids slow PyPI lookups)
shopt -s nullglob
for req in "$PROJECT_ROOT"/backend/*/requirements.txt; do
    svc_dir="$(dirname "$req")"
    REQS_HASH=$(md5sum "$req" 2>/dev/null | cut -d' ' -f1)
    HASH_FILE="$svc_dir/.pip_installed"
    if [ "$(cat "$HASH_FILE" 2>/dev/null)" = "$REQS_HASH" ]; then
        echo -e "  pip requirements for $(basename "$svc_dir") already up to date, skipping..."
        continue
    fi
    echo -e "  Installing pip requirements for $(basename "$svc_dir")..."
    # Vendor with `python3 -m pip`, never a bare `pip`: the first pip on PATH can
    # belong to a different interpreter than the Lambda runtime (python3.13), and
    # a wheel built for one CPython ABI will not import under another - which
    # surfaces only at invoke time as "No module named ...".
    # Errors are shown rather than discarded, and the stamp file is written only
    # on success, so a failed install cannot be silently skipped on the next run.
    if python3 -m pip install --quiet --target="$svc_dir" -r "$req"; then
        echo "$REQS_HASH" > "$HASH_FILE"
        echo -e "  ✓ Installed pip requirements for $(basename "$svc_dir")"
    else
        echo -e "  ✗ Failed to install pip requirements for $(basename "$svc_dir")"
        echo -e "    Check that python3 ($(python3 --version 2>&1)) matches the Lambda runtime."
        exit 1
    fi
done

# Install npm dependencies into each Node.js service directory for hot-reload
for pkg in "$PROJECT_ROOT"/backend/*/package.json; do
    svc_dir="$(dirname "$pkg")"
    echo -e "  Installing npm dependencies for $(basename "$svc_dir")..."
    npm install --prefix "$svc_dir" --silent 2>/dev/null || true
done
shopt -u nullglob

# Change to infrastructure directory
cd "$INFRA_DIR"

# Load participant configuration (provides PARTICIPANT_ID, TF_VAR_aws_app_code, etc.)
PARTICIPANT_CONFIG="$PROJECT_ROOT/ENVIRONMENT.config"
if [ -f "$PARTICIPANT_CONFIG" ]; then
    source "$PARTICIPANT_CONFIG"
fi

# Override credentials for LocalStack
export AWS_ENDPOINT_URL="http://localhost.localstack.cloud:4566"
export AWS_ENDPOINT_URL_S3="http://s3.localhost.localstack.cloud:4566"
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
unset AWS_SESSION_TOKEN

# Ensure the Terraform state bucket exists in LocalStack
BUCKET_NAME="coding-workshop-tfstate-${PARTICIPANT_ID:-abcd1234}"
if ! aws s3 ls 2>/dev/null | grep -q "$BUCKET_NAME"; then
    echo -e "  Creating Terraform state bucket: $BUCKET_NAME"
    aws s3 mb "s3://$BUCKET_NAME" > /dev/null 2>&1 || {
        echo -e "  ✗ Failed to create Terraform state bucket"
        exit 1
    }
fi

# Ensure terraform is initialized against the correct LocalStack backend
terraform init -reconfigure \
    -backend-config="bucket=$BUCKET_NAME" \
    -backend-config="region=${AWS_REGION:-us-east-1}" \
    > /tmp/tf-init.log 2>&1 || {
    echo -e "  ✗ Terraform init failed:"
    tail -n 20 /tmp/tf-init.log | sed 's/^/    /'
    exit 1
}

# Count services on disk vs deployed
SERVICES_ON_DISK=$(find "$PROJECT_ROOT/backend" -mindepth 2 -maxdepth 2 \( -name "function.py" -o -name "package.json" -o -name "pom.xml" \) -not -path "*/_*" -not -path "*/\.*" | wc -l)
SERVICES_DEPLOYED=$(terraform output -json lambda_urls 2>/dev/null | grep -o 'http://[^"]*' | wc -l)

# Check if backend is deployed and all services are present
BACKEND_OK=false
if [ "$SERVICES_DEPLOYED" -ge "$SERVICES_ON_DISK" ] && [ "$SERVICES_DEPLOYED" -gt 0 ]; then
    LAMBDA_URLS=$(terraform output -json lambda_urls 2>/dev/null | grep -o 'http://[^"]*' | head -1 || echo "")
    if [ -n "$LAMBDA_URLS" ]; then
        # Check if Lambda responds with any HTTP status (200 or 500 both mean it's running)
        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$LAMBDA_URLS" 2>/dev/null || echo "000")
        if [ "$HTTP_STATUS" != "000" ]; then
            BACKEND_OK=true
            echo -e "  ✓ Backend is deployed and functions are responding ($SERVICES_DEPLOYED/$SERVICES_ON_DISK services)"
        else
            echo -e "  ⚠ Backend is deployed but functions not responding"
        fi
    fi
else
    echo -e "  ⚠ Services on disk ($SERVICES_ON_DISK) vs deployed ($SERVICES_DEPLOYED) — redeploying..."
fi

if [ "$BACKEND_OK" = false ]; then
    echo -e "  ⚠ Backend not deployed or not working, deploying..."

    # Deploy backend
    $SCRIPT_DIR/deploy-backend.sh local > /tmp/backend-deploy.log 2>&1 || {
        echo -e "  ⚠ Backend deployment failed, resetting LocalStack and retrying..."

        # Stop LocalStack, clear stale state, restart
        localstack stop 2>/dev/null || true
        docker stop localstack-main 2>/dev/null || true
        sleep 5
        localstack start -d

        # Wait for LocalStack to be ready
        for i in {1..30}; do
            if curl -s http://localhost.localstack.cloud:4566/_localstack/health > /dev/null 2>&1; then
                echo -e "  ✓ LocalStack restarted"
                break
            fi
            if [ "$i" -eq 30 ]; then
                echo -e "  ✗ LocalStack failed to restart"
                exit 1
            fi
            sleep 1
        done

        # Retry deploy against clean LocalStack
        $SCRIPT_DIR/deploy-backend.sh local > /tmp/backend-deploy.log 2>&1 || {
            echo -e "  ✗ Backend deployment failed after LocalStack reset"
            tail -n 50 /tmp/backend-deploy.log | sed 's/^/    /'
            exit 1
        }
    }

    echo -e "  ✓ Backend deployed successfully"
fi

# Display Lambda URLs
echo -e "  Lambda Function URLs:"
terraform output -json lambda_urls 2>/dev/null | grep -o 'http://[^"]*' | sed 's/^/    /' || echo "    (none)"

echo ""

# ============================================================
# STEP 5: Check and Start Frontend
# ============================================================
echo -e "[5/5] Checking Frontend..."

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "ERROR: npm is not installed"
    exit 1
fi

# Change to frontend directory
cd "$FRONTEND_DIR"

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "  ⚠ Frontend dependencies not installed, installing..."
    rm -f package-lock.json
    npm install > /tmp/npm-install.log 2>&1 || {
        echo -e "  ✗ npm install failed"
        tail -n 30 /tmp/npm-install.log | sed 's/^/    /'
        exit 1
    }
    echo -e "  ✓ Frontend dependencies installed"
else
    echo -e "  ✓ Frontend dependencies already installed"
fi

# Generate .env.local for frontend
echo -e "  Generating frontend environment configuration..."
"$SCRIPT_DIR/generate-env.sh" > /dev/null 2>&1 || {
    echo -e "  ⚠ Could not generate .env.local"
}

# Restart proxy so it picks up the newly generated .env.local
if [ -f /tmp/proxy-server.pid ]; then
    kill "$(cat /tmp/proxy-server.pid)" || echo "WARN: no process found"
    rm -f /tmp/proxy-server.pid
elif lsof -iTCP:3001 -sTCP:LISTEN > /dev/null 2>&1; then
    lsof -ti:3001 | xargs kill 2>/dev/null
fi

echo -e "  Starting CORS proxy server..."
nohup node "$SCRIPT_DIR/proxy-server.js" > /tmp/proxy-server.log 2>&1 &
PROXY_PID=$!

# Wait for proxy to start
sleep 2

# Verify proxy started
if kill -0 $PROXY_PID 2>/dev/null; then
    echo -e "  ✓ Proxy server started (PID: $PROXY_PID)"
    echo $PROXY_PID > /tmp/proxy-server.pid
else
    echo -e "  ✗ Proxy server failed to start"
    cat /tmp/proxy-server.log | sed 's/^/    /'
    exit 1
fi

# Check if React dev server is already running
REACT_RUNNING=false
if lsof -iTCP:3000 -sTCP:LISTEN > /dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ':3000'; then
    REACT_RUNNING=true
    echo -e "  ✓ React dev server is already running on port 3000"
fi

echo ""
echo "============================================================"
echo -e "  ✓ All Components Verified!"
echo "============================================================"
echo ""
echo "Services Status:"
echo "  • LocalStack:  Running on localhost:4566"
echo "  • PostgreSQL:  Running on localhost:5432"
echo "  • MongoDB:     Running on localhost:27017"

if [ "$REACT_RUNNING" = true ]; then
    echo "  • Frontend:   Already running on localhost:3000"
else
    echo "  • Frontend:   Ready to start"
fi
echo ""

if [ "$REACT_RUNNING" = true ]; then
    echo "All services are running!"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:3001"
else
    echo "Starting React development server..."
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:3001"
    echo ""
    echo "Press Ctrl+C to stop"
    echo ""

    # Cleanup: Kill proxy server when script exits
    if [ -f /tmp/proxy-server.pid ]; then
        PROXY_PID=$(cat /tmp/proxy-server.pid)
        trap "kill $PROXY_PID 2>/dev/null; rm -f /tmp/proxy-server.pid" EXIT
    fi

    # Start React development server
    npm run dev
fi
