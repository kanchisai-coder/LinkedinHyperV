locals {
  hostname  = "AC-Worker-06"
  image_tag = "IMAGE_TAG_PLACEHOLDER"
  registry  = "h4rb0r.acm.acumen-strategy.com"
  project   = "linkedin-outreach"

  frontend_image = "${local.registry}/${local.project}/frontend:${local.image_tag}"
  worker_image   = "${local.registry}/${local.project}/worker:${local.image_tag}"
}

job "linkedin-console" {
  datacenters = ["acumen-dc"]
  type        = "service"

  vault {
    role = "linkedin-console"
  }

  # Multi-node deployment topology across datacenter nodes
  group "console" {
    count = 2

    network {
      mode = "bridge"

      dns {
        servers  = ["172.26.64.1"]
        searches = ["service.consul", "consul"]
      }

      port "frontend_http" {
        static       = 3002
        to           = 3000
        host_network = "public"
      }

      port "worker_http" {
        static       = 3001
        to           = 3001
        host_network = "private"
      }

      port "novnc" {
        static       = 6080
        to           = 6080
        host_network = "public"
      }
    }

    restart {
      attempts = 3
      interval = "10m"
      delay    = "30s"
      mode     = "delay"
    }

    update {
      max_parallel      = 1
      min_healthy_time  = "30s"
      healthy_deadline  = "10m"
      progress_deadline = "15m"
      auto_revert       = true
      canary            = 0
    }

    task "worker" {
      driver = "docker"

      config {
        image = local.worker_image
        force_pull = true
        ports      = ["worker_http", "novnc"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "{{ with secret \"secrets/data/docker/registry\" }}{{ .Data.data.username }}{{ end }}"
          password       = "{{ with secret \"secrets/data/docker/registry\" }}{{ .Data.data.password }}{{ end }}"
        }
      }

      template {
        destination = "secrets/linkedin-console/worker.env"
        env         = true
        data        = <<EOH
{{ with secret "secrets/data/linkedin-console/console" }}
NODE_ENV={{ .Data.data.NODE_ENV }}
REDIS_HOST={{ .Data.data.REDIS_HOST }}
REDIS_PORT={{ .Data.data.REDIS_PORT }}
REDIS_PASSWORD={{ .Data.data.REDIS_PASSWORD }}
REDIS_URL={{ .Data.data.REDIS_URL }}
DATABASE_URL={{ .Data.data.DATABASE_URL }}
POSTGRES_URL={{ .Data.data.POSTGRES_URL }}
SESSION_ENCRYPTION_KEY={{ .Data.data.SESSION_ENCRYPTION_KEY }}
API_SECRET={{ .Data.data.API_SECRET }}
SESSION_TTL_DAYS={{ .Data.data.SESSION_TTL_DAYS }}
BROWSER_USE_SYSTEM_CHROME={{ .Data.data.BROWSER_USE_SYSTEM_CHROME }}
BROWSER_HEADLESS={{ .Data.data.BROWSER_HEADLESS }}
BROWSER_CONTEXT_TTL_MS={{ .Data.data.BROWSER_CONTEXT_TTL_MS }}
BROWSER_PROBE_INTERVAL_MS={{ .Data.data.BROWSER_PROBE_INTERVAL_MS }}
BROWSER_MAX_ACTIVE_CONTEXTS={{ .Data.data.BROWSER_MAX_ACTIVE_CONTEXTS }}
BROWSER_MAX_PAGES_PER_ACCOUNT={{ .Data.data.BROWSER_MAX_PAGES_PER_ACCOUNT }}
WORKER_JOB_TIMEOUT_MS={{ .Data.data.WORKER_JOB_TIMEOUT_MS }}
USE_REBROWSER_PLAYWRIGHT={{ .Data.data.USE_REBROWSER_PLAYWRIGHT }}
XVFB_WIDTH={{ .Data.data.XVFB_WIDTH }}
XVFB_HEIGHT={{ .Data.data.XVFB_HEIGHT }}
XVFB_DEPTH={{ .Data.data.XVFB_DEPTH }}
SYNC_INTERVAL_MINUTES={{ .Data.data.SYNC_INTERVAL_MINUTES }}
BACKFILL_INTERVAL_MINUTES={{ .Data.data.BACKFILL_INTERVAL_MINUTES }}
CONNECTIONS_DELTA_INTERVAL_MINUTES={{ .Data.data.CONNECTIONS_DELTA_INTERVAL_MINUTES }}
INVITATIONS_INTERVAL_MINUTES={{ .Data.data.INVITATIONS_INTERVAL_MINUTES }}
UNIFIED_DELTA_MAX_THREADS={{ .Data.data.UNIFIED_DELTA_MAX_THREADS }}
UNIFIED_BACKFILL_MAX_THREADS={{ .Data.data.UNIFIED_BACKFILL_MAX_THREADS }}
UNIFIED_DELTA_THREAD_LIMIT={{ .Data.data.UNIFIED_DELTA_THREAD_LIMIT }}
UNIFIED_BACKFILL_THREAD_LIMIT={{ .Data.data.UNIFIED_BACKFILL_THREAD_LIMIT }}
ANTIBAN_BUSINESS_HOURS_ENABLED={{ .Data.data.ANTIBAN_BUSINESS_HOURS_ENABLED }}
ANTIBAN_BUSINESS_START={{ .Data.data.ANTIBAN_BUSINESS_START }}
ANTIBAN_BUSINESS_END={{ .Data.data.ANTIBAN_BUSINESS_END }}
ANTIBAN_ALLOW_WEEKENDS={{ .Data.data.ANTIBAN_ALLOW_WEEKENDS }}
ANTIBAN_DEFAULT_TZ={{ .Data.data.ANTIBAN_DEFAULT_TZ }}
ANTIBAN_SURFACE_FAIL_THRESHOLD={{ .Data.data.ANTIBAN_SURFACE_FAIL_THRESHOLD }}
ANTIBAN_SURFACE_COOLDOWN_S={{ .Data.data.ANTIBAN_SURFACE_COOLDOWN_S }}
ANTIBAN_ACCOUNT_COOLDOWN_S={{ .Data.data.ANTIBAN_ACCOUNT_COOLDOWN_S }}
ANTIBAN_ACCOUNT_COOLDOWN_THRESHOLD={{ .Data.data.ANTIBAN_ACCOUNT_COOLDOWN_THRESHOLD }}
ANTIBAN_REQUIRE_PROXY={{ .Data.data.ANTIBAN_REQUIRE_PROXY }}
SYNC_BACKOFF_BLOCKED_MIN={{ .Data.data.SYNC_BACKOFF_BLOCKED_MIN }}
SYNC_BACKOFF_AUTOMATION_WARNING_MIN={{ .Data.data.SYNC_BACKOFF_AUTOMATION_WARNING_MIN }}
SYNC_BACKOFF_CHECKPOINT_MIN={{ .Data.data.SYNC_BACKOFF_CHECKPOINT_MIN }}
SYNC_BACKOFF_EXPIRED_MIN={{ .Data.data.SYNC_BACKOFF_EXPIRED_MIN }}
RATE_LIMIT_HOURLY_MESSAGES_SENT={{ .Data.data.RATE_LIMIT_HOURLY_MESSAGES_SENT }}
RATE_LIMIT_HOURLY_CONNECT_REQUESTS={{ .Data.data.RATE_LIMIT_HOURLY_CONNECT_REQUESTS }}
RATE_LIMIT_HOURLY_PROFILE_VIEWS={{ .Data.data.RATE_LIMIT_HOURLY_PROFILE_VIEWS }}
RATE_LIMIT_HOURLY_SEARCH_QUERIES={{ .Data.data.RATE_LIMIT_HOURLY_SEARCH_QUERIES }}
RATE_LIMIT_HOURLY_INBOX_READS={{ .Data.data.RATE_LIMIT_HOURLY_INBOX_READS }}
USE_VOYAGER_READS={{ .Data.data.USE_VOYAGER_READS }}
USE_REALTIME={{ .Data.data.USE_REALTIME }}
ENABLE_BACKFILL={{ .Data.data.ENABLE_BACKFILL }}
ENABLE_CRED_CAPTURE={{ .Data.data.ENABLE_CRED_CAPTURE }}
ENABLE_AUTO_RELOGIN={{ .Data.data.ENABLE_AUTO_RELOGIN }}
WEBHOOK_ENDPOINTS={{ .Data.data.WEBHOOK_ENDPOINTS }}
NOVNC_PORT={{ .Data.data.NOVNC_PORT }}
NOVNC_PUBLIC_URL={{ .Data.data.NOVNC_PUBLIC_URL }}
PROXY_URL={{ .Data.data.PROXY_URL }}
HTTP_PROXY={{ .Data.data.HTTP_PROXY }}
HTTPS_PROXY={{ .Data.data.HTTPS_PROXY }}
ACCOUNT_IDS={{ .Data.data.ACCOUNT_IDS }}
{{ end }}
EOH
      }

      resources {
        cpu    = 3000
        memory = 3048
      }

      service {
        name = "linkedin-console"
        port = "worker_http"
        tags = ["internal", "api", "linkedin-outreach", "worker"]

        check {
          name     = "worker-health"
          type     = "http"
          path     = "/health"
          interval = "30s"
          timeout  = "10s"
        }
      }

      service {
        name = "linkedin-outreach-novnc"
        port = "novnc"
        tags = ["internal", "novnc", "linkedin-outreach"]

        check {
          name     = "novnc-health"
          type     = "tcp"
          interval = "30s"
          timeout  = "10s"
        }
      }
    }

    task "frontend" {
      driver = "docker"

      config {
        image      = local.frontend_image
        force_pull = true
        ports      = ["frontend_http"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "{{ with secret \"secrets/data/docker/registry\" }}{{ .Data.data.username }}{{ end }}"
          password       = "{{ with secret \"secrets/data/docker/registry\" }}{{ .Data.data.password }}{{ end }}"
        }
      }

      template {
        destination = "secrets/linkedin-console/frontend.env"
        env         = true
        data        = <<EOH
{{ with secret "secrets/data/linkedin-console/frontend" }}
NODE_ENV={{ .Data.data.NODE_ENV }}
API_URL={{ .Data.data.API_URL }}
NEXT_PUBLIC_API_URL={{ .Data.data.NEXT_PUBLIC_API_URL }}
API_SECRET={{ .Data.data.API_SECRET }}
API_ROUTE_AUTH_TOKEN={{ .Data.data.API_ROUTE_AUTH_TOKEN }}
PROXY_AUTH_TOKENS='{{ .Data.data.PROXY_AUTH_TOKENS }}'
PROXY_AUTH_COOKIE_NAME={{ .Data.data.PROXY_AUTH_COOKIE_NAME }}
REDIS_URL={{ .Data.data.REDIS_URL }}
DATABASE_URL={{ .Data.data.DATABASE_URL }}
POSTGRES_URL={{ .Data.data.POSTGRES_URL }}
DASHBOARD_PASSWORD={{ .Data.data.DASHBOARD_PASSWORD }}
JWT_SECRET={{ .Data.data.JWT_SECRET }}
SESSION_MAX_AGE={{ .Data.data.SESSION_MAX_AGE }}
NEXT_PUBLIC_WS_URL={{ .Data.data.NEXT_PUBLIC_WS_URL }}
{{ end }}
EOH
      }

      resources {
        cpu    = 1000
        memory = 1024
      }

      service {
        name = "linkedin-outreach-frontend"
        port = "frontend_http"
        tags = ["internal", "ui", "linkedin-outreach", "frontend"]

        check {
          name     = "frontend-health"
          type     = "http"
          path     = "/login"
          interval = "30s"
          timeout  = "10s"
        }
      }
    }
  }
}
