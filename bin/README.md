# Coding Workshop - Deployment Scripts

## Overview

This directory contains development and deployment scripts that can be used with local development and cloud deployment.

## Quick Start

### Local Development

To run your application locally:

```sh
./bin/start-dev.sh
```

### Cloud Deployment

To deploy your backend to AWS:

```sh
./bin/deploy-backend.sh
```

To deploy your frontend to AWS:

```sh
./bin/deploy-frontend.sh
```

## Available Scripts

### `deploy-backend.sh`

**The main deployment script** - deploys complete infrastructure including backend Lambda functions.

**What it does**:

* Creates VPC, security groups, and networking
* Deploys all Lambda functions with Function URLs
* Sets up S3 bucket for frontend hosting
* Creates CloudFront distribution with routing (AWS only)
* Sets up DocumentDB cluster
* Auto-detects environment (LocalStack vs AWS)
* Loads participant credentials for multi-participant workshops

**When to use**:

* Initial deployment
* After changing Lambda function code
* After adding new Lambda functions (auto-discovered!)
* After infrastructure changes

**Key feature**: Terraform only updates changed resources, so running this after Lambda code changes is fast (~5-10 seconds).

**Usage**:

```sh
./bin/deploy-backend.sh [aws|local]
```

### `deploy-frontend.sh`

Builds and deploys the React frontend to AWS.

**What it does**:

* LocalStack: Displays message to use `npm run dev` (skips S3 deployment)
* AWS:
  * Loads participant environment credentials
  * Runs `npm run build` to create production build
  * Uploads static files to S3 bucket
  * Invalidates CloudFront cache
  * Displays CloudFront URL

**When to use**:

* LocalStack: Don't use this - use `./bin/start-dev.sh` for hot-reload instead
* AWS only: After making changes to React components

**Why skip LocalStack S3?** The dev server (`npm run dev`) provides instant hot-reload (1-2 seconds) vs full build+deploy (~30-60 seconds).

**Usage**:

```sh
./bin/deploy-frontend.sh [aws|local]
```

### `start-dev.sh`

Starts the complete development environment with hot-reload.

**What it does**:

* Starts PostgreSQL in a container published on the Docker bridge address, which
  is where Lambda containers reach it (no `sudo` required)
* Checks MongoDB, continuing with a warning if it is unavailable, since no
  service in this project uses it
* Checks LocalStack is running
* Vendors each service's pip requirements with `python3 -m pip`, so the wheels
  match the Lambda runtime's CPython ABI
* Verifies backend is deployed
* Generates `.env.local` for frontend
* Starts proxy server on port 3001 (CORS workaround)
* Starts React dev server on port 3000 (hot-reload)

**Point the frontend at it** (once):

```sh
echo 'VITE_API_URL=http://localhost:3001' > frontend/.env.development.local
./bin/seed-database.py --url http://localhost:3001
```

**When to use**:

* LocalStack development (recommended workflow)
* Frontend development with backend integration
* Testing full stack locally

**Usage**:

```sh
./bin/start-dev.sh
```

### `generate-env.sh`

Generates `.env.local` file for React frontend.

**What it does**:

* Detects LocalStack vs AWS environment
* Reads Terraform outputs (API URLs, endpoints)
* Generates frontend environment configuration
* LocalStack: Sets proxy URL (`http://localhost:3001`)
* AWS: Sets CloudFront URL

**When to use**:

* After deploying backend
* After adding new Lambda functions
* When switching between LocalStack and AWS

**Usage**:

```sh
./bin/generate-env.sh
```

### `proxy-server.js`

Development CORS proxy server for LocalStack.

**What it does**:

* Listens on port 3001
* Forwards `/api/*` requests to LocalStack Lambda URLs
* Strips browser headers that trigger LocalStack CORS bug
* Adds proper CORS headers to responses

**Why needed**: LocalStack Lambda Function URLs have a CORS bug.

**Usage** (automatically started by `start-dev.sh`):

```sh
node ./bin/proxy-server.js
```

### `seed-database.py`

Populates the facility incident database with realistic demo data.

**What it does**:

* Registers a facility admin, 6 employees and 4 engineers (all `@acme.inc`)
* Creates 3 buildings, 8 floors and 21 seats
* Reports 24 incidents across every category and priority, then drives each one
  through the real workflow (assign, progress, block, resolve, close) so the
  dashboards, hotspots and notes all have something to show
* Idempotent - existing records are reused, so it is safe to re-run

**Why it uses the API rather than `psql`**: Aurora has no public endpoint and its
security group only admits traffic from itself, so the Lambda is the only thing
that can reach the database. Going through the API also means passwords are
hashed by the service and every incident obeys the same validation and RBAC
rules as real user activity.

**When to use**:

* After a fresh `./bin/deploy-backend.sh`, to get a demonstrable dataset
* After `./bin/start-dev.sh`, to populate the local database

**Usage**:

```sh
# Seed the deployed environment (URL read from Terraform outputs)
./bin/seed-database.py

# Seed a specific deployment, or the local dev proxy
./bin/seed-database.py --url https://{lambda-url}.lambda-url.us-east-2.on.aws
./bin/seed-database.py --url http://localhost:3001

# Check connectivity without writing anything
./bin/seed-database.py --dry-run
```

Every seeded account shares the password printed in the summary
(`Workshop#2026` by default, override with `--password`).

**Known limitation**: because seeding goes through the API, every record is
created with the current timestamp, so `GET /dashboard/sla` reports averages of
`0.0` hours. Status counts, hotspots, escalations and workload are all accurate;
only the elapsed-time metrics need real activity over time to become meaningful.

### `setup-participant.sh`

**One-time setup for multi-participant AWS workshops** - configures participant credentials automatically.

**What it does**:

* Auto-detects AWS Account ID from your credentials
* Constructs IAM role ARN: `arn:aws:iam::{ACCOUNT}:role/coding-workshop-{PARTICIPANT_ID}`
* Constructs S3 backend bucket: `coding-workshop-tfstate-{PARTICIPANT_ID}`
* Creates AWS CLI profile: `coding-workshop-{PARTICIPANT_ID}`
* Generates Terraform backend config: `BACKEND.config`
* Creates environment file: `ENVIRONMENT.config` (auto-loaded by `deploy-backend.sh`)

**When to use**:

* Required: Before your first AWS deployment in multi-participant workshops
* Not needed: For LocalStack development (no participant isolation required)

**What you need**: Just 2 things from instructor:

1. Participant ID (e.g., `efgh5678`)
2. Participant Code (e.g., `xK9mP2nR4vT8wQ`)

Everything else (AWS Account ID, S3 bucket name, IAM role) is **automatically detected/derived**.

**Usage**:

```sh
# 1. First, set up environment variables
echo 'export EVENT_ID=your-id' >> ~/.bashrc
echo 'export PARTICIPANT_ID=your-id' >> ~/.bashrc
echo 'export PARTICIPANT_CODE=your-code' >> ~/.bashrc
source ~/.bashrc

# 2. Then, run the setup participant script
./bin/setup-participant.sh
```

### `setup-environment.sh`

Sets up the complete local development environment on Ubuntu 22.04.

**What it does**:

* Installs Docker (Container runtime)
* Installs LocalStack (AWS service emulation)
* Installs AWS CLI v2 (AWS command-line tools)
* Installs Terraform (Infrastructure as Code)
* Installs PostgreSQL (Relational database)
* Installs MongoDB (NoSQL database)
* Optionally: Installs and configures dnsmasq (DNS resolution)

**When to use**:

* Initial machine setup for Ubuntu 22.04
* First-time local development environment installation
* One-time per developer machine

**Prerequisites**:

* Ubuntu 22.04 Desktop
* Administrator/sudo access
* Internet connection for package downloads

**Usage**:

```sh
# Basic setup (without dnsmasq)
./bin/setup-environment.sh

# With dnsmasq DNS configuration
./bin/setup-environment.sh -d

# Dry run (show what would be done without making changes)
./bin/setup-environment.sh -n

# Both dnsmasq and dry run
./bin/setup-environment.sh -d -n
```

**Notes**:

* Script auto-detects if dependencies are already installed and skips redundant steps
* Continues on non-critical errors and reports all issues at the end
* Dry run mode (`-n`) shows planned actions without making changes
* dnsmasq (`-d`) is optional - enables DNS resolution for `.local` domains

### `cleanup-environment.sh`

Destroys all infrastructure resources created by the deployment scripts.

**What it does**:

* Removes all AWS/LocalStack resources (VPC, Lambda, S3, CloudFront, DocumentDB, etc.)
* Uses Terraform to cleanly destroy infrastructure
* Verifies Terraform is installed before proceeding

**When to use**:

* End of workshop to clean up resources
* Before redeploying from scratch
* To avoid unnecessary AWS charges
* When resetting the environment

**Warning**: This action **cannot be undone**. All data and resources will be permanently deleted.

**Prerequisites**:

* Terraform must be installed
* Valid AWS credentials configured (for AWS deployments)
* LocalStack running (for LocalStack deployments)

**Usage**:

```sh
./bin/cleanup-environment.sh
```
