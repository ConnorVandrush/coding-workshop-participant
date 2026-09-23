/*
 * C4 model of the ACME facility incident management platform, as
 * Structurizr DSL.
 *
 * Render it with the Structurizr CLI or Lite:
 *
 *     structurizr-cli export -workspace docs/architecture.dsl -format plantuml
 *     docker run -it --rm -p 8080:8080 \
 *       -v "$PWD/docs:/usr/local/structurizr" structurizr/lite
 *
 * Five views are defined: system context, containers, the components inside
 * the Facility API, a dynamic view of the notification outbox, and the AWS
 * deployment. What is drawn here is what the repository actually builds -
 * infra/*.tf for the deployment, backend/facility-api/app for the components.
 */
workspace "ACME Facility Incident Management" "Self-service reporting and resolution of facility and workplace technology issues." {

    !identifiers hierarchical

    model {
        employee = person "Employee" "Reports faults in their building, follows progress and replies on the note thread. Registers with an @acme.inc address."
        engineer = person "Engineer" "Works the incidents a facility admin assigns them: drives the status, records blockers and resolutions, and answers the reporter."
        admin = person "Facility Admin" "Owns the estate and the queue. Defines buildings, floors and seats, creates engineer profiles, assigns every incident and oversees the lifecycle."

        acme = softwareSystem "Facility Incident Management Platform" "Centralises incident reporting, assignment and reporting across ACME's buildings." {

            spa = container "Single-Page Application" "Serves the three personas one role-aware UI: report and track incidents, drive the workflow, manage facilities and engineers, and read the dashboards." "React 19, Vite, Material UI, Redux Toolkit" "Browser"

            assets = container "Static Site Bucket" "Holds the built SPA - index.html, hashed JS and CSS bundles, and the PWA manifest and service worker." "Amazon S3" "Storage"

            edge = container "Edge Router" "One origin for the whole product. Serves the SPA by default and routes /api/facility-api* to the API's Lambda Function URL; a viewer-request function rewrites deep links to index.html without touching API responses, so API error statuses pass through unchanged." "Amazon CloudFront + CloudFront Functions" "Infrastructure"

            api = container "Facility API" "The system's only writer. Authenticates, enforces role-based access, runs the incident state machine and serves the dashboard aggregations." "Python 3.13, FastAPI, Mangum on AWS Lambda" {

                middleware = component "Request Middleware" "Wraps every request: assigns a trace id, emits one JSON log line per request keyed by the templated route, and renders every failure into the single error envelope." "Starlette middleware"
                security = component "Authentication and Authorisation" "Verifies bearer tokens, hashes passwords with PBKDF2-HMAC-SHA256, rotates refresh tokens on use, and answers the role questions the routers ask." "PyJWT, hashlib"

                authRouter = component "Auth Router" "Registration restricted to @acme.inc, login, refresh, logout and the current profile. The first account on an empty database becomes the facility admin." "FastAPI router"
                usersRouter = component "Users Router" "Facility admins list accounts, change roles and deactivate people." "FastAPI router"
                facilitiesRouter = component "Facilities Router" "CRUD for the estate: buildings, their floors, and the seats on a floor." "FastAPI router"
                engineersRouter = component "Engineers Router" "CRUD for engineer profiles - specialties, availability and the active-incident ceiling that caps assignment." "FastAPI router"
                incidentsRouter = component "Incidents Router" "Incident CRUD, assignment, status transitions, escalation and the note thread, each scoped to what the caller's role may see and do." "FastAPI router"
                dashboardRouter = component "Dashboard Router" "Per-persona reporting: counts by status and priority, location hotspots, acknowledge/assign/resolve durations, and engineer workload." "FastAPI router"
                notificationsRouter = component "Notifications Router" "Serves a person's notification feed and marks it read, draining a bounded batch of the outbox as it goes." "FastAPI router"

                domain = component "Workflow Domain" "The incident state machine - the legal transitions out of Open, In Progress, Blocked, Resolved and Closed, and the narrower set a reporter may drive. Also serves the UI's workflow diagram." "Python module"
                duplicates = component "Duplicate Detection" "Ranks existing incidents against a draft so the reporter is asked whether a fault is already known, using PostgreSQL full-text search with pg_trgm typo tolerance where the extension is available." "Python module"
                outbox = component "Notification Outbox" "Records what happened as one cheap insert on the causing request, and expands a bounded batch into per-recipient rows away from it." "Python module"
                dataAccess = component "Database Access" "Owns the connection, reused across warm invocations, and applies the schema idempotently on cold start." "psycopg 3"
            }

            notifier = container "Notification Worker" "Drains the whole event backlog into per-recipient notification rows wherever something can invoke it, so fan-out is not paid for by whoever happens to read their feed." "Python 3.13 on AWS Lambda"

            db = container "Facility Database" "Users and roles, the building/floor/seat estate, engineer profiles, incidents and their notes, notifications, the event outbox and refresh-token digests." "Amazon Aurora Serverless v2, PostgreSQL 17.7" "Database" {
                # The entity-relationship model, one level below this box. The
                # element is clickable in Structurizr renderers; the same
                # diagram is in the repository as backend/facility-api/schema.dbml,
                # which is what the ERD was generated from.
                url "https://dbdiagram.io/d/6ab3e98d586942561273de1c"
                properties {
                    "ERD" "https://dbdiagram.io/d/6ab3e98d586942561273de1c"
                    "Schema" "backend/facility-api/app/schema.sql"
                    "DBML" "backend/facility-api/schema.dbml"
                }
            }
        }

        # --- People to the product -------------------------------------------
        employee -> acme.spa "Reports faults, tracks them and adds notes"
        engineer -> acme.spa "Works assigned incidents and answers reporters"
        admin -> acme.spa "Defines the estate, assigns work and reads the dashboards"

        # --- Delivery path ----------------------------------------------------
        acme.spa -> acme.edge "Loads the application from, and calls the API through" "HTTPS/JSON"
        acme.edge -> acme.assets "Serves the built bundle from" "HTTPS, origin access control"
        acme.edge -> acme.api.middleware "Forwards /api/facility-api* to" "HTTPS, Lambda Function URL"

        # --- Inside the API ---------------------------------------------------
        acme.api.middleware -> acme.api.authRouter "Routes to"
        acme.api.middleware -> acme.api.usersRouter "Routes to"
        acme.api.middleware -> acme.api.facilitiesRouter "Routes to"
        acme.api.middleware -> acme.api.engineersRouter "Routes to"
        acme.api.middleware -> acme.api.incidentsRouter "Routes to"
        acme.api.middleware -> acme.api.dashboardRouter "Routes to"
        acme.api.middleware -> acme.api.notificationsRouter "Routes to"

        acme.api.authRouter -> acme.api.security "Issues and rotates tokens with"
        acme.api.usersRouter -> acme.api.security "Checks the caller is a facility admin with"
        acme.api.facilitiesRouter -> acme.api.security "Checks the caller is a facility admin with"
        acme.api.engineersRouter -> acme.api.security "Checks the caller is a facility admin with"
        acme.api.incidentsRouter -> acme.api.security "Resolves the caller's role and engineer profile with"
        acme.api.dashboardRouter -> acme.api.security "Scopes the figures to the caller with"
        acme.api.notificationsRouter -> acme.api.security "Identifies the caller with"

        acme.api.incidentsRouter -> acme.api.domain "Validates transitions against"
        acme.api.incidentsRouter -> acme.api.duplicates "Asks for likely duplicates from"
        acme.api.incidentsRouter -> acme.api.outbox "Records assignment, status, escalation and note events in"
        acme.api.notificationsRouter -> acme.api.outbox "Drains a bounded batch of"

        acme.api.authRouter -> acme.api.dataAccess "Reads and writes through"
        acme.api.usersRouter -> acme.api.dataAccess "Reads and writes through"
        acme.api.facilitiesRouter -> acme.api.dataAccess "Reads and writes through"
        acme.api.engineersRouter -> acme.api.dataAccess "Reads and writes through"
        acme.api.incidentsRouter -> acme.api.dataAccess "Reads and writes through"
        acme.api.dashboardRouter -> acme.api.dataAccess "Aggregates through"
        acme.api.security -> acme.api.dataAccess "Loads accounts and token digests through"
        acme.api.duplicates -> acme.api.dataAccess "Ranks candidates through"
        acme.api.outbox -> acme.api.dataAccess "Writes events and notifications through"

        acme.api.dataAccess -> acme.db "Reads from and writes to" "psycopg 3, TLS"

        # --- Deferred fan-out -------------------------------------------------
        # There is no queue: the functions sit in a VPC with no NAT gateway and
        # no interface endpoint, so SQS and the Lambda control plane are
        # unreachable. The database carries the handoff instead.
        acme.notifier -> acme.db "Claims pending events with FOR UPDATE SKIP LOCKED and writes one notification per recipient" "psycopg 3, TLS"

        deploymentEnvironment "Production" {
            deploymentNode "Employee, engineer or facility admin device" "Any desktop or mobile browser; the SPA is installable as a PWA." "Web browser" {
                containerInstance acme.spa
            }

            aws = deploymentNode "Amazon Web Services" "The workshop account. The participant role is an allow-list, which is why there is no CodePipeline and no VPC endpoint." "AWS" {
                deploymentNode "Global edge" "" "Amazon CloudFront, PriceClass_200" {
                    containerInstance acme.edge
                }

                region = deploymentNode "us-east-2" "" "AWS Region" {
                    deploymentNode "Static hosting" "" "Amazon S3, origin access control" {
                        containerInstance acme.assets
                    }

                    lambda = deploymentNode "AWS Lambda" "512 MB, python3.13, in-VPC. The memory is a CPU setting as much as a size one: sign-in is PBKDF2 at 240,000 iterations." "AWS Lambda" {
                        apiInstance = containerInstance acme.api
                        notifierInstance = containerInstance acme.notifier
                    }

                    deploymentNode "Amazon Aurora" "Serverless v2, 0-4 ACUs, encrypted, 7-day backups." "Aurora PostgreSQL 17.7" {
                        containerInstance acme.db
                    }

                    dlq = infrastructureNode "Dead-letter Queues" "One per function, for invocations that fail after their retries." "Amazon SQS"
                    logs = infrastructureNode "CloudWatch Logs and Metrics" "One JSON line per request becomes ServerErrors, ClientErrors and RequestDurationMs through metric filters. Alarms are written but default to off: the participant role has no cloudwatch:Put." "Amazon CloudWatch"

                    lambda.apiInstance -> logs "Emits one structured line per request to"
                    lambda.notifierInstance -> logs "Emits progress and failures to"
                    lambda.apiInstance -> dlq "Failed invocations land in"
                    lambda.notifierInstance -> dlq "Failed invocations land in"
                }
            }
        }
    }


    views {
        systemContext acme "SystemContext" "Who uses the platform. It deliberately integrates with nothing else - the brief scopes it to self-service." {
            include *
            autolayout lr
        }

        container acme "Containers" "One CloudFront origin in front of a static bucket and a Lambda-hosted API, with Aurora behind it." {
            include *
            autolayout lr
        }

        component acme.api "ApiComponents" "Inside the Facility API: middleware, the routers, and the modules they lean on." {
            include *
            autolayout lr
        }

        dynamic acme "NotificationFanOut" "How a change reaches the people it concerns, without a queue and without slowing the request that caused it." {
            acme.spa -> acme.edge "An engineer moves an incident to Blocked"
            acme.edge -> acme.api "Forwards POST /incidents/{id}/status"
            acme.api -> acme.db "Applies the transition and inserts one outbox event, then returns"
            acme.notifier -> acme.db "Later, and off that request: claims the event and writes a notification for the reporter, the assignee and the facility admins"
            acme.spa -> acme.edge "The reporter's browser polls the feed and sees it"
            autolayout lr
        }

        deployment acme "Production" "AwsDeployment" "What Terraform builds in infra/." {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape person
                background #1f6feb
                color #ffffff
            }
            element "Software System" {
                background #0b4f9e
                color #ffffff
            }
            element "Container" {
                background #2f81f7
                color #ffffff
            }
            element "Component" {
                background #6aa6f8
                color #0b1c33
            }
            element "Browser" {
                shape WebBrowser
            }
            element "Database" {
                shape Cylinder
            }
            element "Storage" {
                shape Folder
            }
            element "Infrastructure" {
                shape RoundedBox
            }
        }
    }

}
