locals {
  hostname      = "AC-Worker-06"
  image_tag     = "20260527-voyager"
  registry      = "h4rb0r.acm.acumen-strategy.com"
  project       = "linkedin-outreach"

  frontend_image = "${local.registry}/${local.project}/frontend:${local.image_tag}"
  worker_image   = "${local.registry}/${local.project}/worker:${local.image_tag}"

  novnc_public_url = "https://linkedin-novnc.acm.acumen-strategy.com"
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
        # image_tag is MUTABLE (we overwrite the same tag on each push). Without
        # force_pull, a node that already cached this tag at an older digest will
        # NOT re-pull on `nomad job run` → you silently keep running stale code.
        force_pull = true
        ports = ["worker_http", "novnc"]

        auth {
          server_address = "h4rb0r.acm.acumen-strategy.com"
          username       = "admin"
          password       = "AcumenRegP455"
        }
      }

      env {
        NODE_ENV = "production"

        REDIS_HOST     = "proxy.redis-production.service.consul"
        REDIS_PORT     = "6379"
        REDIS_PASSWORD = "8560869df25afcd2bd7f7eca73babe19f8b027be"
        REDIS_URL      = "redis://:8560869df25afcd2bd7f7eca73babe19f8b027be@proxy.redis-production.service.consul:6379/1"

        DATABASE_URL = "postgresql://linkedinuser:LinkedInOutreach2026@master.db-acumen.service.consul:5432/linkedin_db"
        POSTGRES_URL = "postgresql://linkedinuser:LinkedInOutreach2026@master.db-acumen.service.consul:5432/linkedin_db"

        SESSION_ENCRYPTION_KEY = "78bd8cc8c39fb6ec4830ab006e78acb8851f520521b685edaaa4314eff2e8c73"
        API_SECRET             = "02eaea7b5ed9c841161615c2f339864acf874c437aa4abc417b2f02273efe2e5"

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
        # Flip to "1" for testing AFTER validating shapes with:
        #   nomad alloc exec -task worker <alloc> node src/voyager/probe.js personl 30
        USE_VOYAGER_READS = "0"   # route inbox/thread reads via Voyager API (scraper fallback stays)
        USE_REALTIME      = "0"   # open the realtime event stream per account
        # JSON array of webhook subscribers, e.g.
        # [{"url":"https://your/hook","secret":"whsec_x","events":["message.*"],"accounts":["*"]}]
        WEBHOOK_ENDPOINTS = ""
        EVENT_STREAM_MAXLEN  = "100000"
        WEBHOOK_MAX_ATTEMPTS = "8"

        NOVNC_PORT       = "6080"
        NOVNC_PUBLIC_URL = local.novnc_public_url

        # ── Proxy ───────────────────────────────────────────────────────
        # Empty = direct egress from the datacenter IP (167.71.211.25) — the
        # root LinkedIn ban cause. Drop a residential/mobile proxy URL here, or
        # per-account via PROXY_FOR_<ACCOUNTID> (e.g. PROXY_FOR_PERSONL).
        PROXY_URL   = ""
        HTTP_PROXY  = ""
        HTTPS_PROXY = ""
        # PROXY_FOR_PERSONL  = "socks5://user:pass@host:1080"
        # PROXY_FOR_TEST     = "socks5://user:pass@host:1080"
        # ANTIBAN_TZ_PERSONL = "America/New_York"

        ACCOUNT_IDS = ""
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
          password       = "AcumenRegP455"
        }
      }

      env {
        NODE_ENV = "production"

        API_URL             = "http://127.0.0.1:3001"
        NEXT_PUBLIC_API_URL = "https://linkedin-console.acm.acumen-strategy.com/api"

        API_SECRET             = "02eaea7b5ed9c841161615c2f339864acf874c437aa4abc417b2f02273efe2e5"
        API_ROUTE_AUTH_TOKEN   = "9e49ba23a05c1130dc22517500220ba61751fe5616a104e54052dc42accb6a0a"
        PROXY_AUTH_TOKENS      = "[\"edcd90a75320bcae64b73d7a7b982281c400787199984f07a90dffd430c016cb\"]"
        PROXY_AUTH_COOKIE_NAME = "app_proxy_auth"

        REDIS_URL = "redis://:8560869df25afcd2bd7f7eca73babe19f8b027be@proxy.redis-production.service.consul:6379/1"

        DATABASE_URL = "postgresql://linkedinuser:LinkedInOutreach2026@master.db-acumen.service.consul:5432/linkedin_db"
        POSTGRES_URL = "postgresql://linkedinuser:LinkedInOutreach2026@master.db-acumen.service.consul:5432/linkedin_db"

        DASHBOARD_PASSWORD = "LinkedIn@Acumen2026!"
        JWT_SECRET         = "8c7f5972b742d7224e5deb63df3eff06bf7d33fc5ac8613c95f022704c0132d7"
        SESSION_MAX_AGE    = "2592000"

        NEXT_PUBLIC_WS_URL = "https://linkedin-console.acm.acumen-strategy.com"
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
