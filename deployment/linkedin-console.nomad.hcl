locals {
  hostname      = "AC-Worker-06"
  image_tag     = "20260527-voyager"
  registry      = "h4rb0r.acm.acumen-strategy.com"
  project       = "linkedin-outreach"

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
    # SECURITY (F2): count = 1 enforces the BullMQ concurrency = 1 invariant
    # cluster-wide to prevent account bans caused by competing browser sessions.
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
        # SECURITY (F1): noVNC must NOT be publicly reachable.
        # Set to private so access is only possible via nginx auth_basic proxy.
        host_network = "private"
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
        ports = ["worker_http", "novnc"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "admin"
          password       = "REPLACE_VIA_AGENT_CONFIG"
        }
      }

      env {
        NODE_ENV = "production"

        REDIS_HOST     = "proxy.redis-production.service.consul"
        REDIS_PORT     = "6379"

        SESSION_TTL_DAYS = "30"

        # ── Browser / VNC ──────────────────────────────────────────────
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

        # ── Cadence (anti-ban) ─────────────────────────────────────────
        SYNC_INTERVAL_MINUTES              = "30"
        BACKFILL_INTERVAL_MINUTES          = "240"
        CONNECTIONS_DELTA_INTERVAL_MINUTES = "60"
        INVITATIONS_INTERVAL_MINUTES       = "120"
        UNIFIED_DELTA_MAX_THREADS          = "1"
        UNIFIED_BACKFILL_MAX_THREADS       = "1"
        UNIFIED_DELTA_THREAD_LIMIT         = "4"
        UNIFIED_BACKFILL_THREAD_LIMIT      = "8"

        # ── Anti-ban gates ─────────────────────────────────────────────
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
        SYNC_BACKOFF_BLOCKED_MIN              = "2880"
        SYNC_BACKOFF_AUTOMATION_WARNING_MIN   = "10080"
        SYNC_BACKOFF_CHECKPOINT_MIN           = "1440"
        SYNC_BACKOFF_EXPIRED_MIN              = "720"

        # ── Hourly rate caps ───────────────────────────────────────────
        RATE_LIMIT_HOURLY_MESSAGES_SENT    = "4"
        RATE_LIMIT_HOURLY_CONNECT_REQUESTS = "3"
        RATE_LIMIT_HOURLY_PROFILE_VIEWS    = "10"
        RATE_LIMIT_HOURLY_SEARCH_QUERIES   = "6"
        RATE_LIMIT_HOURLY_INBOX_READS      = "60"

        # ── Voyager / realtime / webhooks (master plan) — OFF by default ──
        USE_VOYAGER_READS = "0"
        USE_REALTIME      = "0"
        WEBHOOK_ENDPOINTS = ""
        EVENT_STREAM_MAXLEN  = "100000"
        WEBHOOK_MAX_ATTEMPTS = "8"

        NOVNC_PORT       = "6080"
        NOVNC_PUBLIC_URL = local.novnc_public_url

        # ── Proxy ───────────────────────────────────────────────────────
        PROXY_URL   = ""
        HTTP_PROXY  = ""
        HTTPS_PROXY = ""

        ACCOUNT_IDS = ""
      }

      # SECURITY (F0): Secrets rendered from Nomad variable into a file.
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
        force_pull = true
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

      # SECURITY (F0, F4): Secrets rendered from Nomad variable into a file.
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
        SESSION_ENCRYPTION_KEY={{ .session_encryption_key }}
        TRUSTED_PROXY_IP={{ or .trusted_proxy_ip "127.0.0.1" }}
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
