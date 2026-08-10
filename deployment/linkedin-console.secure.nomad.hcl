// Secrets-externalized variant of linkedin-console.nomad.hcl.
// All sensitive values are read at runtime from the Nomad variable
//   nomad/jobs/linkedin-console
// via template{} stanzas — nothing secret is committed to git.
//
// Populate the variable first (see deployment/SECRET_ROTATION.md):
//   nomad var put nomad/jobs/linkedin-console \
//     redis_password=... db_password=... session_encryption_key=... \
//     api_secret=... api_route_auth_token=... jwt_secret=... \
//     proxy_auth_token=... dashboard_password=...
//
// Then: nomad job run linkedin-console.secure.nomad.hcl

locals {
  hostname  = "AC-Worker-06"
  image_tag = "20260526-antiban-vnc"
  registry  = "h4rb0r.acm.acumen-strategy.com"
  project   = "linkedin-outreach"

  frontend_image = "${local.registry}/${local.project}/frontend:${local.image_tag}"
  worker_image   = "${local.registry}/${local.project}/worker:${local.image_tag}"

  novnc_public_url = "https://linkedin-novnc.acm.acumen-strategy.com"
  var_path         = "nomad/jobs/linkedin-console"
}

job "linkedin-console" {
  datacenters = ["acumen-dc"]
  type        = "service"

  constraint {
    attribute = "${attr.unique.hostname}"
    value     = local.hostname
  }

  group "console" {
    count = 1

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
        ports = ["worker_http", "novnc"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "admin"
          # Harbor pw still here because Docker pull auth needs it before any
          # template renders. Prefer a Nomad-agent-level registry credential
          # (docker.auth.config in client config) to remove it entirely.
          password       = "REPLACE_VIA_AGENT_CONFIG"
        }
      }

      # Non-secret env stays inline.
      env {
        NODE_ENV = "production"

        REDIS_HOST = "proxy.redis-production.service.consul"
        REDIS_PORT = "6379"

        SESSION_TTL_DAYS = "30"

        BROWSER_USE_SYSTEM_CHROME = "1"
        BROWSER_HEADLESS          = "0"
        BROWSER_CONTEXT_TTL_MS    = "300000"
        BROWSER_PROBE_INTERVAL_MS = "30000"
        BROWSER_MAX_ACTIVE_CONTEXTS   = "1"
        BROWSER_MAX_PAGES_PER_ACCOUNT = "1"
        WORKER_JOB_TIMEOUT_MS     = "90000"
        USE_REBROWSER_PLAYWRIGHT  = "1"
        XVFB_WIDTH  = "1366"
        XVFB_HEIGHT = "768"
        XVFB_DEPTH  = "16"

        SYNC_INTERVAL_MINUTES              = "30"
        BACKFILL_INTERVAL_MINUTES          = "240"
        CONNECTIONS_DELTA_INTERVAL_MINUTES = "60"
        INVITATIONS_INTERVAL_MINUTES       = "120"
        UNIFIED_DELTA_MAX_THREADS          = "1"
        UNIFIED_BACKFILL_MAX_THREADS       = "1"
        UNIFIED_DELTA_THREAD_LIMIT         = "4"
        UNIFIED_BACKFILL_THREAD_LIMIT      = "8"

        ANTIBAN_BUSINESS_HOURS_ENABLED     = "true"
        ANTIBAN_BUSINESS_START             = "9"
        ANTIBAN_BUSINESS_END               = "18"
        ANTIBAN_ALLOW_WEEKENDS             = "false"
        ANTIBAN_DEFAULT_TZ                 = "America/New_York"
        ANTIBAN_SURFACE_FAIL_THRESHOLD     = "3"
        ANTIBAN_SURFACE_COOLDOWN_S         = "21600"
        ANTIBAN_ACCOUNT_COOLDOWN_S         = "43200"
        ANTIBAN_ACCOUNT_COOLDOWN_THRESHOLD = "3"
        ANTIBAN_REQUIRE_PROXY              = "0"
        SYNC_BACKOFF_BLOCKED_MIN            = "2880"
        SYNC_BACKOFF_AUTOMATION_WARNING_MIN = "10080"
        SYNC_BACKOFF_CHECKPOINT_MIN         = "1440"
        SYNC_BACKOFF_EXPIRED_MIN            = "720"
        RATE_LIMIT_HOURLY_MESSAGES_SENT    = "4"
        RATE_LIMIT_HOURLY_CONNECT_REQUESTS = "3"
        RATE_LIMIT_HOURLY_PROFILE_VIEWS    = "10"
        RATE_LIMIT_HOURLY_SEARCH_QUERIES   = "6"
        RATE_LIMIT_HOURLY_INBOX_READS      = "60"

        NOVNC_PORT       = "6080"
        NOVNC_PUBLIC_URL = local.novnc_public_url

        # PROXY: set these to a residential/mobile endpoint to stop egressing
        # from the datacenter IP 167.71.211.25 (the root ban cause).
        PROXY_URL   = ""
        HTTP_PROXY  = ""
        HTTPS_PROXY = ""
        ACCOUNT_IDS = ""
      }

      # Secrets rendered from the Nomad variable into a file, sourced as env.
      template {
        destination = "secrets/worker.env"
        env         = true
        change_mode = "restart"
        data        = <<-EOT
        {{- with nomadVar "${local.var_path}" }}
        REDIS_PASSWORD={{ .redis_password }}
        REDIS_URL=redis://:{{ .redis_password }}@proxy.redis-production.service.consul:6379/1
        DATABASE_URL=postgresql://linkedinuser:{{ .db_password }}@master.db-acumen.service.consul:5432/linkedin_db
        POSTGRES_URL=postgresql://linkedinuser:{{ .db_password }}@master.db-acumen.service.consul:5432/linkedin_db
        SESSION_ENCRYPTION_KEY={{ .session_encryption_key }}
        API_SECRET={{ .api_secret }}
        {{- end }}
        EOT
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
        image = local.frontend_image
        ports = ["frontend_http"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "admin"
          password       = "REPLACE_VIA_AGENT_CONFIG"
        }
      }

      env {
        NODE_ENV = "production"

        API_URL             = "http://127.0.0.1:3001"
        NEXT_PUBLIC_API_URL = "https://linkedin-console.acm.acumen-strategy.com/api"
        PROXY_AUTH_COOKIE_NAME = "app_proxy_auth"
        SESSION_MAX_AGE        = "2592000"
        NEXT_PUBLIC_WS_URL     = "https://linkedin-console.acm.acumen-strategy.com"
      }

      template {
        destination = "secrets/frontend.env"
        env         = true
        change_mode = "restart"
        data        = <<-EOT
        {{- with nomadVar "${local.var_path}" }}
        API_SECRET={{ .api_secret }}
        API_ROUTE_AUTH_TOKEN={{ .api_route_auth_token }}
        PROXY_AUTH_TOKENS=["{{ .proxy_auth_token }}"]
        JWT_SECRET={{ .jwt_secret }}
        DASHBOARD_PASSWORD={{ .dashboard_password }}
        REDIS_URL=redis://:{{ .redis_password }}@proxy.redis-production.service.consul:6379/1
        DATABASE_URL=postgresql://linkedinuser:{{ .db_password }}@master.db-acumen.service.consul:5432/linkedin_db
        POSTGRES_URL=postgresql://linkedinuser:{{ .db_password }}@master.db-acumen.service.consul:5432/linkedin_db
        {{- end }}
        EOT
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
