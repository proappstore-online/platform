// AUTO-GENERATED OpenAPI 3.1 spec for the ProAppStore API.
// Source of truth: the backend route table (packages/backend/src/routes/*).
// Regenerate when routes change; served at GET /openapi.json and /openapi.yaml.

export const openapiSpec: Record<string, unknown> = {
  "openapi": "3.1.0",
  "info": {
    "title": "ProAppStore Platform API",
    "version": "1.0.0",
    "description": "REST API for ProAppStore (PAS) \u2014 the Pro app marketplace platform.\n\nPowers identity, app provisioning + deploy, the per-app backend services (KV, counters, storage, rooms, secrets, AI, email/SMS, maps, push), the storefront + submissions review flow, the Agent Teams build loop, billing, and creator payouts.\n\nAuth: send `Authorization: Bearer <PAS session JWT>` (HS256, from `/v1/auth/exchange` or an OAuth flow). A handful of service-to-service routes use the `X-Internal-Token` header instead. Public routes need no auth.\n\nThis spec is generated from the backend route table; request/response bodies are typed for the core resources and generic (object) elsewhere."
  },
  "servers": [
    {
      "url": "https://api.proappstore.online",
      "description": "Production"
    }
  ],
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "tags": [
    {
      "name": "Health",
      "description": ""
    },
    {
      "name": "Auth",
      "description": "OAuth (GitHub/Google), credential, and session-exchange endpoints."
    },
    {
      "name": "Billing",
      "description": "Pro subscription status, Stripe Checkout, and billing portal."
    },
    {
      "name": "Apps",
      "description": "App listing and dashboard management."
    },
    {
      "name": "Submissions",
      "description": "Pro app review flow (submit, list, approve/reject)."
    },
    {
      "name": "Provisioning",
      "description": "Provision app infrastructure (route + D1 + data worker)."
    },
    {
      "name": "Listings",
      "description": "Storefront publishing and the public storefront browse API."
    },
    {
      "name": "Teams",
      "description": "App team membership and invites."
    },
    {
      "name": "Invites",
      "description": "App invite links (create/list/redeem)."
    },
    {
      "name": "Roles",
      "description": "App-level custom roles and role checks."
    },
    {
      "name": "Key Vault",
      "description": "Encrypted BYO API-key vault (AES-256-GCM) + proxy usage."
    },
    {
      "name": "KV Storage",
      "description": "Per-app key-value storage."
    },
    {
      "name": "Counters",
      "description": "Per-app integer counters."
    },
    {
      "name": "Storage",
      "description": "R2-backed per-app file storage (private + public)."
    },
    {
      "name": "Tools",
      "description": "MCP tool registration per app (SQL-backed actions)."
    },
    {
      "name": "Actions",
      "description": "Execute custom per-app serverless actions."
    },
    {
      "name": "Secrets",
      "description": "Per-app secret storage proxy."
    },
    {
      "name": "Domains",
      "description": "Custom domain attach/verify/detach."
    },
    {
      "name": "Stripe Connect",
      "description": "Creator payout onboarding via Stripe Connect."
    },
    {
      "name": "Email",
      "description": "Transactional email delivery."
    },
    {
      "name": "SMS",
      "description": "Twilio SMS delivery."
    },
    {
      "name": "Notifications",
      "description": "Web Push subscriptions and delivery."
    },
    {
      "name": "Analytics",
      "description": "Per-app usage analytics + the public instrumentation endpoints."
    },
    {
      "name": "Usage",
      "description": "Per-user and per-app API usage tracking."
    },
    {
      "name": "Payouts",
      "description": "Creator payout preview and the monthly payout cron."
    },
    {
      "name": "Logs",
      "description": "Per-app build and runtime logs."
    },
    {
      "name": "Maps",
      "description": "Geocoding, reverse-geocoding, and routing."
    },
    {
      "name": "AI",
      "description": "Workers AI text generation, embeddings, and model listing."
    },
    {
      "name": "App Webhooks",
      "description": "Per-app outbound webhook configuration."
    },
    {
      "name": "Services",
      "description": "Creator services marketplace profiles, balance, earnings."
    },
    {
      "name": "Engagements",
      "description": "Service engagements, messaging, and workspace."
    },
    {
      "name": "Rooms",
      "description": "Realtime collaboration rooms (Durable Objects, WebSocket)."
    },
    {
      "name": "Webhooks",
      "description": "Inbound provider webhooks (Stripe). Signature-verified, not user-facing."
    },
    {
      "name": "Licensing",
      "description": "Per-app license key issuance and validation."
    }
  ],
  "paths": {
    "/": {
      "get": {
        "tags": [
          "Health"
        ],
        "summary": "Service health",
        "operationId": "get",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/health": {
      "get": {
        "tags": [
          "Health"
        ],
        "summary": "Health check",
        "operationId": "get_health",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/ai/embed": {
      "post": {
        "tags": [
          "AI"
        ],
        "summary": "Create embed",
        "operationId": "post_v1_ai_embed",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/ai/generate": {
      "post": {
        "tags": [
          "AI"
        ],
        "summary": "Create generate",
        "operationId": "post_v1_ai_generate",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/ai/models": {
      "get": {
        "tags": [
          "AI"
        ],
        "summary": "List models",
        "operationId": "get_v1_ai_models",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/analytics.js": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List analytics script",
        "operationId": "get_v1_analytics_js",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/analytics/admin/platform": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List platform",
        "operationId": "get_v1_analytics_admin_platform",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/analytics/event": {
      "post": {
        "tags": [
          "Analytics"
        ],
        "summary": "Event analytics",
        "operationId": "post_v1_analytics_event",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps": {
      "get": {
        "tags": [
          "Apps"
        ],
        "summary": "List apps",
        "operationId": "get_v1_apps",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/apps/{appId}/actions/{name}": {
      "post": {
        "tags": [
          "Actions"
        ],
        "summary": "Create actions",
        "operationId": "post_v1_apps_appId_actions_name",
        "description": "Run a registered action. Auth: a PAS session JWT, OR a personal app token `Authorization: Bearer pas_at_…` minted for THIS app (#154; roles fixed to `user`, read tokens may call query actions only, action-scoped tokens only their actions). Public actions (requires_auth false) need no auth. A `verify` action (#148) runs its scoped SELECT, hands the rows to the platform verifier named in its manifest (e.g. `chess.replay`), and — when the verifier completes — runs its write statements in one transaction with the verdict bound as `:__verify_<output>`; it answers `{ ok, verifier, output, error?, writes? }` (200 with `ok: false` and no write when the input could not be verified).",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/allowlist": {
      "get": {
        "tags": [
          "Secrets"
        ],
        "summary": "List allowlist",
        "operationId": "get_v1_apps_appId_allowlist",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "put": {
        "tags": [
          "Secrets"
        ],
        "summary": "Set allowlist",
        "operationId": "put_v1_apps_appId_allowlist",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "Secrets"
        ],
        "summary": "Delete allowlist",
        "operationId": "delete_v1_apps_appId_allowlist",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/analytics": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List analytics",
        "operationId": "get_v1_apps_appId_analytics",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "put": {
        "tags": [
          "Analytics"
        ],
        "summary": "Set analytics",
        "operationId": "put_v1_apps_appId_analytics",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/analytics/diagnostics": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List diagnostics",
        "operationId": "get_v1_apps_appId_analytics_diagnostics",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/analytics/events": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List events",
        "operationId": "get_v1_apps_appId_analytics_events",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/analytics/live": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List live",
        "operationId": "get_v1_apps_appId_analytics_live",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/analytics/stats": {
      "get": {
        "tags": [
          "Analytics"
        ],
        "summary": "List stats",
        "operationId": "get_v1_apps_appId_analytics_stats",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/counters": {
      "get": {
        "tags": [
          "Counters"
        ],
        "summary": "List counters",
        "operationId": "get_v1_apps_appId_counters",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/counters/{key}": {
      "get": {
        "tags": [
          "Counters"
        ],
        "summary": "Get counters",
        "operationId": "get_v1_apps_appId_counters_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "key",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "Counters"
        ],
        "summary": "Create counters",
        "operationId": "post_v1_apps_appId_counters_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "key",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/domains": {
      "post": {
        "tags": [
          "Domains"
        ],
        "summary": "Create domains",
        "operationId": "post_v1_apps_appId_domains",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Domains"
        ],
        "summary": "List domains",
        "operationId": "get_v1_apps_appId_domains",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/domains/{domain}": {
      "delete": {
        "tags": [
          "Domains"
        ],
        "summary": "Delete domains",
        "operationId": "delete_v1_apps_appId_domains_domain",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "domain",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/domains/{domain}/verify": {
      "post": {
        "tags": [
          "Domains"
        ],
        "summary": "Verify domains",
        "operationId": "post_v1_apps_appId_domains_domain_verify",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "domain",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/files": {
      "get": {
        "tags": [
          "Storage"
        ],
        "summary": "List files",
        "operationId": "get_v1_apps_appId_files",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/invites": {
      "post": {
        "tags": [
          "Invites"
        ],
        "summary": "Create invites",
        "operationId": "post_v1_apps_appId_invites",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Invites"
        ],
        "summary": "List invites",
        "operationId": "get_v1_apps_appId_invites",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/invites/{inviteId}": {
      "delete": {
        "tags": [
          "Invites"
        ],
        "summary": "Delete invites",
        "operationId": "delete_v1_apps_appId_invites_inviteId",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "inviteId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/kv": {
      "get": {
        "tags": [
          "KV Storage"
        ],
        "summary": "List kv",
        "operationId": "get_v1_apps_appId_kv",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/kv/{key}": {
      "get": {
        "tags": [
          "KV Storage"
        ],
        "summary": "Get kv",
        "operationId": "get_v1_apps_appId_kv_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "key",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "put": {
        "tags": [
          "KV Storage"
        ],
        "summary": "Set kv",
        "operationId": "put_v1_apps_appId_kv_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "key",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "KV Storage"
        ],
        "summary": "Delete kv",
        "operationId": "delete_v1_apps_appId_kv_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "key",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/license": {
      "get": {
        "tags": [
          "Licensing"
        ],
        "summary": "List license",
        "operationId": "get_v1_apps_appId_license",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "Licensing"
        ],
        "summary": "Issue license",
        "operationId": "post_v1_apps_appId_license",
        "description": "Mint the caller's license key for this app, or return the existing live one (idempotent). Requires an active platform subscription. Keys are 256 random bits, base64url.",
        "responses": {
          "200": {
            "description": "Existing license returned"
          },
          "201": {
            "description": "New license issued"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "description": "Subscription inactive"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Licensing"
        ],
        "summary": "Revoke license",
        "operationId": "delete_v1_apps_appId_license",
        "description": "Revoke the caller's own license key(s) for this app (for a leaked key). Returns the number revoked; POST mints a replacement.",
        "responses": {
          "200": {
            "description": "Success"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/alerts": {
      "get": {
        "tags": [
          "Logs"
        ],
        "summary": "Operational alerts for an app (#107)",
        "description": "Owner only. Spikes the scheduled evaluator recorded from app_logs (client runtime errors, server-side action failures and 5xx) and QA runs: kind, window, count, affected users (a count), the previous window's baseline, top categories / operations / fingerprints and build metadata. Never messages, request bodies, tokens or user ids. Query: since (ms, default 7 days), limit (≤ 200), open=1 for unacknowledged only.",
        "operationId": "get_v1_apps_appId_alerts",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "alerts": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer"
                          },
                          "app_id": {
                            "type": "string"
                          },
                          "kind": {
                            "type": "string",
                            "enum": [
                              "error_spike",
                              "action_failures",
                              "server_5xx",
                              "qa_failures"
                            ]
                          },
                          "window_start": {
                            "type": "integer"
                          },
                          "window_end": {
                            "type": "integer"
                          },
                          "count": {
                            "type": "integer"
                          },
                          "affected_users": {
                            "type": "integer",
                            "description": "distinct sessions or anonymous client ids — a count, never a list"
                          },
                          "baseline": {
                            "type": "integer",
                            "description": "the same measure in the previous window"
                          },
                          "top": {
                            "type": "object",
                            "properties": {
                              "categories": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              },
                              "operations": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              },
                              "fingerprints": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              }
                            }
                          },
                          "build": {
                            "type": "object",
                            "nullable": true
                          },
                          "created_at": {
                            "type": "integer"
                          },
                          "acknowledged_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "acknowledged_by": {
                            "type": "string",
                            "nullable": true
                          }
                        }
                      }
                    },
                    "since": {
                      "type": "integer"
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/alerts/evaluate": {
      "post": {
        "tags": [
          "Logs"
        ],
        "summary": "Evaluate the alert thresholds for an app now (#107)",
        "description": "Owner only. Runs the same evaluation the 15-minute cron runs, scoped to this app, records any spike (idempotent per window) and returns the report.",
        "operationId": "post_v1_apps_appId_alerts_evaluate",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "checkedAt": {
                      "type": "string"
                    },
                    "windowMs": {
                      "type": "integer"
                    },
                    "alerts": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "integer"
                          },
                          "app_id": {
                            "type": "string"
                          },
                          "kind": {
                            "type": "string",
                            "enum": [
                              "error_spike",
                              "action_failures",
                              "server_5xx",
                              "qa_failures"
                            ]
                          },
                          "window_start": {
                            "type": "integer"
                          },
                          "window_end": {
                            "type": "integer"
                          },
                          "count": {
                            "type": "integer"
                          },
                          "affected_users": {
                            "type": "integer",
                            "description": "distinct sessions or anonymous client ids — a count, never a list"
                          },
                          "baseline": {
                            "type": "integer",
                            "description": "the same measure in the previous window"
                          },
                          "top": {
                            "type": "object",
                            "properties": {
                              "categories": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              },
                              "operations": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              },
                              "fingerprints": {
                                "type": "array",
                                "items": {
                                  "type": "object"
                                }
                              }
                            }
                          },
                          "build": {
                            "type": "object",
                            "nullable": true
                          },
                          "created_at": {
                            "type": "integer"
                          },
                          "acknowledged_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "acknowledged_by": {
                            "type": "string",
                            "nullable": true
                          }
                        }
                      }
                    },
                    "recorded": {
                      "type": "integer"
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/alerts/{id}/ack": {
      "post": {
        "tags": [
          "Logs"
        ],
        "summary": "Acknowledge an alert (#107)",
        "operationId": "post_v1_apps_appId_alerts_id_ack",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "description": "Not found or already acknowledged"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/logs": {
      "post": {
        "tags": [
          "Logs"
        ],
        "summary": "Create logs",
        "operationId": "post_v1_apps_appId_logs",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Logs"
        ],
        "summary": "List logs",
        "operationId": "get_v1_apps_appId_logs",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/logs/build": {
      "get": {
        "tags": [
          "Logs"
        ],
        "summary": "List build",
        "operationId": "get_v1_apps_appId_logs_build",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/public/{path}": {
      "get": {
        "tags": [
          "Storage"
        ],
        "summary": "Get public",
        "operationId": "get_v1_apps_appId_public_path",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "path",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Catch-all sub-path (may contain slashes)."
          }
        ]
      }
    },
    "/v1/apps/{appId}/roles": {
      "get": {
        "tags": [
          "Roles"
        ],
        "summary": "List roles",
        "operationId": "get_v1_apps_appId_roles",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "Roles"
        ],
        "summary": "Create roles",
        "operationId": "post_v1_apps_appId_roles",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "Roles"
        ],
        "summary": "Delete roles",
        "operationId": "delete_v1_apps_appId_roles",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/roles/check/{role}": {
      "get": {
        "tags": [
          "Roles"
        ],
        "summary": "Get check",
        "operationId": "get_v1_apps_appId_roles_check_role",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "role",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/roles/ensure-member": {
      "post": {
        "tags": [
          "Roles"
        ],
        "summary": "Create ensure member",
        "operationId": "post_v1_apps_appId_roles_ensure_member",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/roles/me": {
      "get": {
        "tags": [
          "Roles"
        ],
        "summary": "List me",
        "operationId": "get_v1_apps_appId_roles_me",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/rooms/{roomId}": {
      "get": {
        "tags": [
          "Rooms"
        ],
        "summary": "Get rooms",
        "operationId": "get_v1_apps_appId_rooms_roomId",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "roomId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/secrets": {
      "get": {
        "tags": [
          "Secrets"
        ],
        "summary": "List secrets",
        "operationId": "get_v1_apps_appId_secrets",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/secrets/{name}": {
      "put": {
        "tags": [
          "Secrets"
        ],
        "summary": "Set secrets",
        "operationId": "put_v1_apps_appId_secrets_name",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "Secrets"
        ],
        "summary": "Delete secrets",
        "operationId": "delete_v1_apps_appId_secrets_name",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/storage/{path}": {
      "put": {
        "tags": [
          "Storage"
        ],
        "summary": "Set storage",
        "operationId": "put_v1_apps_appId_storage_path",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "path",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Catch-all sub-path (may contain slashes)."
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Storage"
        ],
        "summary": "Get storage",
        "operationId": "get_v1_apps_appId_storage_path",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "path",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Catch-all sub-path (may contain slashes)."
          }
        ]
      },
      "delete": {
        "tags": [
          "Storage"
        ],
        "summary": "Delete storage",
        "operationId": "delete_v1_apps_appId_storage_path",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "path",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Catch-all sub-path (may contain slashes)."
          }
        ]
      }
    },
    "/v1/apps/{appId}/team": {
      "get": {
        "tags": [
          "Teams"
        ],
        "summary": "List team",
        "operationId": "get_v1_apps_appId_team",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/team/invite": {
      "post": {
        "tags": [
          "Teams"
        ],
        "summary": "Create invite",
        "operationId": "post_v1_apps_appId_team_invite",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/team/{userRef}": {
      "put": {
        "tags": [
          "Teams"
        ],
        "summary": "Set team",
        "operationId": "put_v1_apps_appId_team_userRef",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "userRef",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "Teams"
        ],
        "summary": "Delete team",
        "operationId": "delete_v1_apps_appId_team_userRef",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "userRef",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/tokens": {
      "post": {
        "tags": [
          "Tokens"
        ],
        "summary": "Mint a personal app token (#154)",
        "description": "Session only (a pas_at_ token can never manage tokens). Returns the plaintext `pas_at_…` token ONCE; only its SHA-256 is stored. `access` and `expires_in` (seconds) are required. Lifetime is capped at 90 days when the request Origin is an app origin, 365 days from a first-party origin or no Origin — no token is non-expiring. `actions` restricts the token to named actions, each of which must exist for the app.",
        "operationId": "post_v1_apps_appId_tokens",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "access",
                  "expires_in"
                ],
                "properties": {
                  "label": {
                    "type": "string"
                  },
                  "expires_in": {
                    "type": "integer",
                    "description": "Lifetime in seconds (min 60)"
                  },
                  "access": {
                    "type": "string",
                    "enum": [
                      "read",
                      "write"
                    ]
                  },
                  "actions": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "maxItems": 50
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "token": {
                      "type": "string",
                      "description": "pas_at_… — shown once"
                    },
                    "token_id": {
                      "type": "string"
                    },
                    "app_id": {
                      "type": "string"
                    },
                    "label": {
                      "type": "string",
                      "nullable": true
                    },
                    "access": {
                      "type": "string"
                    },
                    "actions": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      },
                      "nullable": true
                    },
                    "created_origin": {
                      "type": "string",
                      "nullable": true
                    },
                    "created_at": {
                      "type": "integer"
                    },
                    "expires_at": {
                      "type": "integer"
                    },
                    "note": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "description": "App not found"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "get": {
        "tags": [
          "Tokens"
        ],
        "summary": "List my tokens for an app (#154)",
        "description": "Never returns the token or its hash.",
        "operationId": "get_v1_apps_appId_tokens",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "token_id": {
                            "type": "string"
                          },
                          "app_id": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string",
                            "nullable": true
                          },
                          "access": {
                            "type": "string",
                            "enum": [
                              "read",
                              "write"
                            ]
                          },
                          "actions": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            },
                            "nullable": true
                          },
                          "created_origin": {
                            "type": "string",
                            "nullable": true
                          },
                          "created_at": {
                            "type": "integer"
                          },
                          "last_used_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "expires_at": {
                            "type": "integer"
                          },
                          "expired": {
                            "type": "boolean"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/tokens/{tokenId}": {
      "delete": {
        "tags": [
          "Tokens"
        ],
        "summary": "Revoke one of my tokens (#154)",
        "description": "Exact match on token id + caller + app; another user's token id is 404.",
        "operationId": "delete_v1_apps_appId_tokens_tokenId",
        "responses": {
          "200": {
            "description": "Success"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "404": {
            "description": "Token not found"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "tokenId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/me/tokens": {
      "get": {
        "tags": [
          "Tokens"
        ],
        "summary": "Every token I hold across apps (#154)",
        "description": "For the dashboard: app id, label, scopes, origin, created / last used / expiry, so a token minted by an app can always be found and revoked from a surface the creator does not control.",
        "operationId": "get_v1_me_tokens",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "token_id": {
                            "type": "string"
                          },
                          "app_id": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string",
                            "nullable": true
                          },
                          "access": {
                            "type": "string",
                            "enum": [
                              "read",
                              "write"
                            ]
                          },
                          "actions": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            },
                            "nullable": true
                          },
                          "created_origin": {
                            "type": "string",
                            "nullable": true
                          },
                          "created_at": {
                            "type": "integer"
                          },
                          "last_used_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "expires_at": {
                            "type": "integer"
                          },
                          "expired": {
                            "type": "boolean"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/apps/{appId}/tools": {
      "put": {
        "tags": [
          "Tools"
        ],
        "summary": "Set tools",
        "operationId": "put_v1_apps_appId_tools",
        "responses": {
          "200": {
            "description": "Registered. Reports the manifest's model-facing byte cost (name + description + params, never SQL) beside the count, and a soft warning above 50 000 bytes (#117).",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ToolRegistrationResult"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Tools"
        ],
        "summary": "List tools",
        "operationId": "get_v1_apps_appId_tools",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Tools"
        ],
        "summary": "Delete tools",
        "operationId": "delete_v1_apps_appId_tools",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/endpoints": {
      "get": {
        "tags": [
          "Tools"
        ],
        "summary": "List console-defined endpoints (#155)",
        "description": "Owner only. Endpoints built in the console (names api_*), stored beside code tools under source = 'console'. status re-runs schema coherence: a column dropped by a later migration reads 'broken' with the error.",
        "operationId": "get_v1_apps_appId_endpoints",
        "responses": {
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "endpoints": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "config": {
                            "type": "object"
                          },
                          "manifest": {
                            "type": "object"
                          },
                          "updated_at": {
                            "type": "integer"
                          },
                          "updated_by": {
                            "type": "string"
                          },
                          "status": {
                            "type": "string",
                            "enum": [
                              "ok",
                              "broken"
                            ]
                          },
                          "error": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/endpoints/preview": {
      "post": {
        "tags": [
          "Tools"
        ],
        "summary": "Preview the manifest a config would generate (#155)",
        "description": "Owner only. Reads the table schema from the app's data worker, generates the SQL and runs the same validators as mcp.json registration. Nothing is saved.",
        "operationId": "post_v1_apps_appId_endpoints_preview",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "config"
                ],
                "properties": {
                  "config": {
                    "type": "object",
                    "description": "EndpointConfig: name (api_…), description, kind (read|insert), table, scope (own|all|public), owner_column, columns, filters, sort, page_size, paginate, generated, defaults, app_roles. Never SQL."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "manifest": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid config: { error, details }"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "422": {
            "description": "Schema coherence: the generated SQL references a missing table or column"
          },
          "503": {
            "description": "The app schema could not be read from its data worker"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/endpoints/{name}": {
      "put": {
        "tags": [
          "Tools"
        ],
        "summary": "Create or update a console-defined endpoint (#155)",
        "description": "Owner only; a personal app token is rejected. Writes the app_tools row (source = 'console') and its app_endpoint_audit entry in one batch. Console endpoints survive deploys; max 30 per app.",
        "operationId": "put_v1_apps_appId_endpoints_name",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "config"
                ],
                "properties": {
                  "config": {
                    "type": "object",
                    "description": "EndpointConfig: name (api_…), description, kind (read|insert), table, scope (own|all|public), owner_column, columns, filters, sort, page_size, paginate, generated, defaults, app_roles. Never SQL."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "endpoint": {
                      "type": "object"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid config, prefix missing, or console cap reached"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "409": {
            "description": "The name is registered by the app's code (mcp.json)"
          },
          "422": {
            "description": "Schema coherence failure"
          },
          "503": {
            "description": "The app schema could not be read"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Tools"
        ],
        "summary": "Delete a console-defined endpoint (#155)",
        "description": "Owner only. Removes source = 'console' rows only, audited. Code tools are managed by deploys.",
        "operationId": "delete_v1_apps_appId_endpoints_name",
        "responses": {
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "200": {
            "description": "Success"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "description": "No console endpoint with that name"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/tools/internal": {
      "post": {
        "tags": [
          "Tools"
        ],
        "summary": "Create internal",
        "operationId": "post_v1_apps_appId_tools_internal",
        "responses": {
          "200": {
            "description": "Registered — same result shape as PUT /v1/apps/{appId}/tools (#117).",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ToolRegistrationResult"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/tools/{name}": {
      "delete": {
        "tags": [
          "Tools"
        ],
        "summary": "Delete tools",
        "operationId": "delete_v1_apps_appId_tools_name",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "name",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/webhooks": {
      "get": {
        "tags": [
          "App Webhooks"
        ],
        "summary": "List webhooks",
        "operationId": "get_v1_apps_appId_webhooks",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "App Webhooks"
        ],
        "summary": "Create webhooks",
        "operationId": "post_v1_apps_appId_webhooks",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{appId}/webhooks/{id}": {
      "delete": {
        "tags": [
          "App Webhooks"
        ],
        "summary": "Delete webhooks",
        "operationId": "delete_v1_apps_appId_webhooks_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{appId}/webhooks/{id}/test": {
      "post": {
        "tags": [
          "App Webhooks"
        ],
        "summary": "Test webhooks",
        "operationId": "post_v1_apps_appId_webhooks_id_test",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{id}": {
      "delete": {
        "tags": [
          "Apps"
        ],
        "summary": "Delete apps",
        "operationId": "delete_v1_apps_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/apps/{id}/listing": {
      "get": {
        "tags": [
          "Listings"
        ],
        "summary": "List listing",
        "operationId": "get_v1_apps_id_listing",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "put": {
        "tags": [
          "Listings"
        ],
        "summary": "Set listing",
        "operationId": "put_v1_apps_id_listing",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{id}/listing-assets/{kind}": {
      "put": {
        "tags": [
          "Listings"
        ],
        "summary": "Set listing assets",
        "operationId": "put_v1_apps_id_listing_assets_kind",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "kind",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/apps/{id}/usage": {
      "get": {
        "tags": [
          "Usage"
        ],
        "summary": "List usage",
        "operationId": "get_v1_apps_id_usage",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/auth/credentials/change-password": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Change Password credentials",
        "operationId": "post_v1_auth_credentials_change_password",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/turnstile": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "Turnstile config for sign-up forms (#26)",
        "operationId": "get_v1_auth_turnstile",
        "description": "Anonymous, cacheable (5 min). `siteKey` is the public Turnstile widget site key when the bot check is enforced on POST /v1/auth/credentials/register (both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY set on the API), else null — render the widget only when non-null, with data-action = `action` (`register`). Hosted apps read it as /.pas/auth/turnstile on their origin (SDK `auth.turnstileSiteKey()`).",
        "responses": {
          "200": {
            "description": "Success"
          }
        }
      }
    },
    "/v1/auth/credentials/login": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Create login",
        "operationId": "post_v1_auth_credentials_login",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/credentials/provision": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Provision credentials",
        "operationId": "post_v1_auth_credentials_provision",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/credentials/register": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Self-service registration for a credential account (#118)",
        "description": "Anonymous. Creates an adult credential account (id cred:<uuid>, provider credential, is_child 0, created_by null) from an email + password. Always answers 202 { ok: true }: for a new address the account is created; for an already-registered address nothing changes and, when a sender is configured, that address is emailed a notice — no enumeration, and both paths hash the password. No session is minted: sign in through POST /v1/auth/credentials/login with the email. Policy: 12+ characters, common passwords refused. Rate-limited per client address (10 per 15 minutes) independently of the per-login lockout. Disabled when CREDENTIAL_SELF_REGISTRATION=0 (403). Bot check (#26): when Turnstile is configured on the API the request must carry a widget token minted with action `register` — `turnstileToken` body field or `CF-Turnstile-Response` header — verified before anything else; 403 `bot check required` / `bot check failed`, 503 `bot check unavailable`. GET /v1/auth/turnstile says whether it is on. Browser apps use the SDK's auth.register(), which goes through /.pas/auth/credentials/register on the app origin.",
        "operationId": "post_v1_auth_credentials_register",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "email",
                  "password"
                ],
                "properties": {
                  "email": {
                    "type": "string",
                    "format": "email"
                  },
                  "password": {
                    "type": "string",
                    "minLength": 12,
                    "maxLength": 256
                  },
                  "displayName": {
                    "type": "string",
                    "maxLength": 80
                  }
                }
              }
            }
          }
        },
        "responses": {
          "202": {
            "description": "Accepted — the account exists now, or existed already (indistinguishable by design)",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "description": "Invalid email, or the password fails the policy (the message says which)"
          },
          "403": {
            "description": "Self-registration is disabled on this platform"
          },
          "429": {
            "description": "Too many registrations from this address"
          }
        },
        "security": []
      }
    },
    "/v1/auth/credentials/reset-password": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Reset Password credentials",
        "operationId": "post_v1_auth_credentials_reset_password",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/email/start": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Start email",
        "operationId": "post_v1_auth_email_start",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/exchange/oidc": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Exchange a GitHub Actions OIDC token for an e2e session (#146)",
        "description": "Keyless CI sessions. Bearer: the workflow's OIDC token (audience https://api.proappstore.online), verified RS256 against GitHub's JWKS with issuer, audience and expiry checks. A platform admin must first grant the repository (optionally one workflow, on one ref) the right to mint sessions for a designated e2e account; no grant → 403. The session lasts 4 hours, carries via: 'oidc-e2e', has roles user + creator and never admin. Every mint is recorded.",
        "operationId": "post_v1_auth_exchange_oidc",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "sessionToken": {
                      "type": "string"
                    },
                    "expiresAt": {
                      "type": "integer"
                    },
                    "via": {
                      "type": "string",
                      "enum": [
                        "oidc-e2e"
                      ]
                    },
                    "grant": {
                      "type": "object"
                    },
                    "user": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "login": {
                          "type": "string"
                        },
                        "avatarUrl": {
                          "type": "string",
                          "nullable": true
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "Missing or invalid OIDC token"
          },
          "403": {
            "description": "No matching grant (repository / workflow / ref), foreign org, or the granted account no longer exists"
          }
        },
        "security": [
          {
            "githubOidc": []
          }
        ]
      }
    },
    "/v1/admin/oidc-session-grants": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "List e2e session grants (platform admin, #146)",
        "operationId": "get_v1_admin_oidc_session_grants",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "grants": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string"
                          },
                          "repository": {
                            "type": "string"
                          },
                          "workflow": {
                            "type": "string",
                            "nullable": true
                          },
                          "ref": {
                            "type": "string"
                          },
                          "user_id": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string",
                            "nullable": true
                          },
                          "created_by": {
                            "type": "string"
                          },
                          "created_at": {
                            "type": "integer"
                          },
                          "revoked_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "last_minted_at": {
                            "type": "integer",
                            "nullable": true
                          },
                          "mint_count": {
                            "type": "integer"
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      },
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Grant a repository the right to mint e2e sessions for an account (platform admin, #146)",
        "operationId": "post_v1_admin_oidc_session_grants",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "repository",
                  "user_id"
                ],
                "properties": {
                  "repository": {
                    "type": "string",
                    "description": "proappstore-online/<repo>"
                  },
                  "user_id": {
                    "type": "string",
                    "description": "gh:<id> — must have signed in once"
                  },
                  "workflow": {
                    "type": "string",
                    "description": ".github/workflows/<file>.yml; omit for any workflow of the repo"
                  },
                  "ref": {
                    "type": "string",
                    "default": "refs/heads/main"
                  },
                  "label": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "grant": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "repository": {
                          "type": "string"
                        },
                        "workflow": {
                          "type": "string",
                          "nullable": true
                        },
                        "ref": {
                          "type": "string"
                        },
                        "user_id": {
                          "type": "string"
                        },
                        "label": {
                          "type": "string",
                          "nullable": true
                        },
                        "created_by": {
                          "type": "string"
                        },
                        "created_at": {
                          "type": "integer"
                        },
                        "revoked_at": {
                          "type": "integer",
                          "nullable": true
                        },
                        "last_minted_at": {
                          "type": "integer",
                          "nullable": true
                        },
                        "mint_count": {
                          "type": "integer"
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "description": "The account does not exist"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/admin/oidc-session-grants/{id}": {
      "delete": {
        "tags": [
          "Auth"
        ],
        "summary": "Revoke an e2e session grant (platform admin, #146)",
        "operationId": "delete_v1_admin_oidc_session_grants_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "description": "Grant not found or already revoked"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/auth/exchange": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Create exchange",
        "operationId": "post_v1_auth_exchange",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/me": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "List me",
        "operationId": "get_v1_auth_me",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/User"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/auth/me/date-of-birth": {
      "patch": {
        "tags": [
          "Auth"
        ],
        "summary": "Update date of birth",
        "operationId": "patch_v1_auth_me_date_of_birth",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/auth/{provider}/callback": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "List callback",
        "operationId": "get_v1_auth_provider_callback",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "parameters": [
          {
            "name": "provider",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/auth/{provider}/start": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "List start",
        "operationId": "get_v1_auth_provider_start",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "parameters": [
          {
            "name": "provider",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/checkout": {
      "post": {
        "tags": [
          "Billing"
        ],
        "summary": "Create checkout",
        "operationId": "post_v1_checkout",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/connect/onboard": {
      "post": {
        "tags": [
          "Stripe Connect"
        ],
        "summary": "Onboard connect",
        "operationId": "post_v1_connect_onboard",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/connect/status": {
      "get": {
        "tags": [
          "Stripe Connect"
        ],
        "summary": "List status",
        "operationId": "get_v1_connect_status",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/email/send": {
      "post": {
        "tags": [
          "Email"
        ],
        "summary": "Send email",
        "operationId": "post_v1_email_send",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/internal/apps/{appId}/analytics/cf-token": {
      "put": {
        "tags": [
          "Analytics"
        ],
        "summary": "Set cf token",
        "operationId": "put_v1_internal_apps_appId_analytics_cf_token",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "parameters": [
          {
            "name": "appId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/internal/payouts/run": {
      "post": {
        "tags": [
          "Payouts"
        ],
        "summary": "Run payouts",
        "operationId": "post_v1_internal_payouts_run",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/invites/{code}/redeem": {
      "post": {
        "tags": [
          "Invites"
        ],
        "summary": "Redeem invites",
        "operationId": "post_v1_invites_code_redeem",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "code",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/keys": {
      "get": {
        "tags": [
          "Key Vault"
        ],
        "summary": "List keys",
        "operationId": "get_v1_keys",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/keys/providers": {
      "get": {
        "tags": [
          "Key Vault"
        ],
        "summary": "List providers",
        "operationId": "get_v1_keys_providers",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/keys/resolve/{provider}": {
      "get": {
        "tags": [
          "Key Vault"
        ],
        "summary": "Get resolve",
        "operationId": "get_v1_keys_resolve_provider",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          },
          {
            "internalToken": []
          }
        ],
        "parameters": [
          {
            "name": "provider",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/keys/status": {
      "get": {
        "tags": [
          "Key Vault"
        ],
        "summary": "List status",
        "operationId": "get_v1_keys_status",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/keys/usage": {
      "get": {
        "tags": [
          "Key Vault"
        ],
        "summary": "List usage",
        "operationId": "get_v1_keys_usage",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/keys/{provider}": {
      "put": {
        "tags": [
          "Key Vault"
        ],
        "summary": "Set keys",
        "operationId": "put_v1_keys_provider",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "provider",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "delete": {
        "tags": [
          "Key Vault"
        ],
        "summary": "Delete keys",
        "operationId": "delete_v1_keys_provider",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "provider",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/license/validate": {
      "post": {
        "tags": [
          "Licensing"
        ],
        "summary": "Validate license",
        "operationId": "post_v1_license_validate",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/maps/geocode": {
      "get": {
        "tags": [
          "Maps"
        ],
        "summary": "List geocode",
        "operationId": "get_v1_maps_geocode",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/maps/reverse": {
      "get": {
        "tags": [
          "Maps"
        ],
        "summary": "List reverse",
        "operationId": "get_v1_maps_reverse",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/maps/route": {
      "get": {
        "tags": [
          "Maps"
        ],
        "summary": "List route",
        "operationId": "get_v1_maps_route",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/me/is-admin": {
      "get": {
        "tags": [
          "Submissions"
        ],
        "summary": "List is admin",
        "operationId": "get_v1_me_is_admin",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/notifications/notify-user": {
      "post": {
        "tags": [
          "Notifications"
        ],
        "summary": "Notify User notifications",
        "operationId": "post_v1_notifications_notify_user",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/notifications/send": {
      "post": {
        "tags": [
          "Notifications"
        ],
        "summary": "Send notifications",
        "operationId": "post_v1_notifications_send",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/notifications/subscribe": {
      "post": {
        "tags": [
          "Notifications"
        ],
        "summary": "Subscribe notifications",
        "operationId": "post_v1_notifications_subscribe",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/notifications/unsubscribe": {
      "post": {
        "tags": [
          "Notifications"
        ],
        "summary": "Unsubscribe notifications",
        "operationId": "post_v1_notifications_unsubscribe",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/notifications/vapid-key": {
      "get": {
        "tags": [
          "Notifications"
        ],
        "summary": "List vapid key",
        "operationId": "get_v1_notifications_vapid_key",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/payouts/me/preview": {
      "get": {
        "tags": [
          "Payouts"
        ],
        "summary": "List preview",
        "operationId": "get_v1_payouts_me_preview",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/portal": {
      "post": {
        "tags": [
          "Billing"
        ],
        "summary": "Create portal",
        "operationId": "post_v1_portal",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/pricing": {
      "get": {
        "tags": [
          "Billing"
        ],
        "summary": "List pricing",
        "operationId": "get_v1_pricing",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Pricing"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/provision": {
      "post": {
        "tags": [
          "Provisioning"
        ],
        "summary": "Provision",
        "operationId": "post_v1_provision",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/provision-data": {
      "post": {
        "tags": [
          "Provisioning"
        ],
        "summary": "Create provision data",
        "operationId": "post_v1_provision_data",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/balance": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List balance",
        "operationId": "get_v1_services_balance",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/balance/confirm": {
      "post": {
        "tags": [
          "Services"
        ],
        "summary": "Confirm balance",
        "operationId": "post_v1_services_balance_confirm",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/balance/deposit": {
      "post": {
        "tags": [
          "Services"
        ],
        "summary": "Deposit balance",
        "operationId": "post_v1_services_balance_deposit",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/balance/transactions": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List transactions",
        "operationId": "get_v1_services_balance_transactions",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/developers": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List developers",
        "operationId": "get_v1_services_developers",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/developers/{id}": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "Get developers",
        "operationId": "get_v1_services_developers_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/services/earnings": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List earnings",
        "operationId": "get_v1_services_earnings",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/engagements": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Create engagements",
        "operationId": "post_v1_services_engagements",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "List engagements",
        "operationId": "get_v1_services_engagements",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/engagements/{id}": {
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "Get engagements",
        "operationId": "get_v1_services_engagements_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "patch": {
        "tags": [
          "Engagements"
        ],
        "summary": "Update engagements",
        "operationId": "patch_v1_services_engagements_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/engagements/{id}/messages": {
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "List messages",
        "operationId": "get_v1_services_engagements_id_messages",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Create messages",
        "operationId": "post_v1_services_engagements_id_messages",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/engagements/{id}/rate": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Rate engagements",
        "operationId": "post_v1_services_engagements_id_rate",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/engagements/{id}/read": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Read engagements",
        "operationId": "post_v1_services_engagements_id_read",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/engagements/{id}/refund": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Refund engagements",
        "operationId": "post_v1_services_engagements_id_refund",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/engagements/{id}/workspace": {
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "List workspace",
        "operationId": "get_v1_services_engagements_id_workspace",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Create workspace",
        "operationId": "post_v1_services_engagements_id_workspace",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/my-requests": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List my requests",
        "operationId": "get_v1_services_my_requests",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/profile": {
      "get": {
        "tags": [
          "Services"
        ],
        "summary": "List profile",
        "operationId": "get_v1_services_profile",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      },
      "put": {
        "tags": [
          "Services"
        ],
        "summary": "Set profile",
        "operationId": "put_v1_services_profile",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/profile/availability": {
      "patch": {
        "tags": [
          "Services"
        ],
        "summary": "Update availability",
        "operationId": "patch_v1_services_profile_availability",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/recompute-stats": {
      "post": {
        "tags": [
          "Services"
        ],
        "summary": "Recompute Stats services",
        "operationId": "post_v1_services_recompute_stats",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "internalToken": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/requests": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Create requests",
        "operationId": "post_v1_services_requests",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "List requests",
        "operationId": "get_v1_services_requests",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/services/requests/{id}": {
      "delete": {
        "tags": [
          "Engagements"
        ],
        "summary": "Delete requests",
        "operationId": "delete_v1_services_requests_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/services/requests/{id}/accept": {
      "post": {
        "tags": [
          "Engagements"
        ],
        "summary": "Accept requests",
        "operationId": "post_v1_services_requests_id_accept",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/services/unread": {
      "get": {
        "tags": [
          "Engagements"
        ],
        "summary": "List unread",
        "operationId": "get_v1_services_unread",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/sms/send": {
      "post": {
        "tags": [
          "SMS"
        ],
        "summary": "Send sms",
        "operationId": "post_v1_sms_send",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/storefront/apps": {
      "get": {
        "tags": [
          "Listings"
        ],
        "summary": "List apps",
        "operationId": "get_v1_storefront_apps",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": []
      }
    },
    "/v1/storefront/apps/{id}": {
      "get": {
        "tags": [
          "Listings"
        ],
        "summary": "Get apps",
        "operationId": "get_v1_storefront_apps_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/submissions": {
      "post": {
        "tags": [
          "Submissions"
        ],
        "summary": "Create submissions",
        "operationId": "post_v1_submissions",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      },
      "get": {
        "tags": [
          "Submissions"
        ],
        "summary": "List submissions",
        "operationId": "get_v1_submissions",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/submissions/{id}": {
      "get": {
        "tags": [
          "Submissions"
        ],
        "summary": "Get submissions",
        "operationId": "get_v1_submissions_id",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Submission"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Submissions"
        ],
        "summary": "Delete submissions",
        "operationId": "delete_v1_submissions_id",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/v1/submissions/{id}/approve": {
      "post": {
        "tags": [
          "Submissions"
        ],
        "summary": "Approve submissions",
        "operationId": "post_v1_submissions_id_approve",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/submissions/{id}/reject": {
      "post": {
        "tags": [
          "Submissions"
        ],
        "summary": "Reject submissions",
        "operationId": "post_v1_submissions_id_reject",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/subscription": {
      "get": {
        "tags": [
          "Billing"
        ],
        "summary": "List subscription",
        "operationId": "get_v1_subscription",
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Subscription"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/team/accept/{token}": {
      "post": {
        "tags": [
          "Teams"
        ],
        "summary": "Create accept",
        "operationId": "post_v1_team_accept_token",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "parameters": [
          {
            "name": "token",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/v1/usage/me": {
      "get": {
        "tags": [
          "Usage"
        ],
        "summary": "List me",
        "operationId": "get_v1_usage_me",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/usage/owner-summary": {
      "get": {
        "tags": [
          "Usage"
        ],
        "summary": "List owner summary",
        "operationId": "get_v1_usage_owner_summary",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ]
      }
    },
    "/v1/usage/ping": {
      "post": {
        "tags": [
          "Usage"
        ],
        "summary": "Ping usage",
        "description": "Records session_seconds/api_calls for (app, user, day). Attribution is bound to the app origin the host asserts (X-PAS-App, set by platform mediation): a mismatch with the body's appId is refused (403); a ping without the mediated origin (direct API call, legacy-bearer SDK) is acknowledged with recorded=false and not stored; only active subscribers' usage is recorded (#58).",
        "operationId": "post_v1_usage_ping",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          },
          "403": {
            "description": "app context mismatch (the mediated origin names a different app than the body)"
          }
        },
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    },
    "/webhooks/stripe": {
      "post": {
        "tags": [
          "Webhooks"
        ],
        "summary": "Create stripe",
        "operationId": "post_webhooks_stripe",
        "responses": {
          "200": {
            "description": "Success"
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object"
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "githubOidc": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "GitHub Actions OIDC JWT",
        "description": "A GitHub Actions OIDC token (permissions: id-token: write; audience https://api.proappstore.online). Accepted by the keyless deploy routes and POST /v1/auth/exchange/oidc."
      },
      "appToken": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "pas_at_…",
        "description": "Personal app token (#154): per-user, per-app, revocable; accepted by POST /v1/apps/{appId}/actions/{name} only. Never by MCP or any other route."
      },
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
        "description": "PAS session JWT (HS256). uid/login/roles claims."
      },
      "internalToken": {
        "type": "apiKey",
        "in": "header",
        "name": "X-Internal-Token",
        "description": "Shared secret for service-to-service calls."
      }
    },
    "responses": {
      "BadRequest": {
        "description": "Invalid request",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Unauthorized": {
        "description": "Missing or invalid token",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      }
    },
    "schemas": {
      "ToolRegistrationResult": {
        "type": "object",
        "required": ["ok", "registered", "bytes", "bytesPerTool", "estimatedTokens", "warnings"],
        "properties": {
          "ok": { "type": "boolean" },
          "registered": { "type": "integer", "description": "Number of tools now registered for the app." },
          "bytes": { "type": "integer", "description": "Model-facing payload of the whole manifest — name, description and params per tool, never SQL — in UTF-8 bytes (#117)." },
          "bytesPerTool": { "type": "number", "description": "bytes / registered, rounded." },
          "estimatedTokens": { "type": "integer", "description": "bytes / 4, rounded — a rule-of-thumb token occupancy per MCP call, not a tokenizer." },
          "warnings": { "type": "array", "items": { "type": "string" }, "description": "Empty when under the 50 000-byte soft threshold; otherwise one message naming the cost. Never a rejection." }
        }
      },
      "Error": {
        "type": "object",
        "properties": {
          "error": {
            "type": "string"
          }
        },
        "required": [
          "error"
        ]
      },
      "User": {
        "type": "object",
        "properties": {
          "uid": {
            "type": "string",
            "description": "e.g. gh:123 | google:123 | cred:uuid"
          },
          "login": {
            "type": "string"
          },
          "avatarUrl": {
            "type": "string"
          },
          "roles": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "user",
                "creator",
                "admin"
              ]
            }
          }
        }
      },
      "App": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "creator_id": {
            "type": "string"
          },
          "d1_database_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "Submission": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "app_id": {
            "type": "string"
          },
          "creator_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "rejected"
            ]
          },
          "name": {
            "type": "string"
          },
          "category": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "suggested_monthly_price_cents": {
            "type": "integer"
          },
          "repo_url": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "Subscription": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "active",
              "trialing",
              "past_due",
              "canceled",
              "none"
            ]
          },
          "tier": {
            "type": "string"
          },
          "current_period_end": {
            "type": "integer"
          },
          "cancel_at_period_end": {
            "type": "boolean"
          }
        }
      },
      "Pricing": {
        "type": "object",
        "properties": {
          "price_cents": {
            "type": "integer",
            "example": 900
          },
          "currency": {
            "type": "string",
            "example": "usd"
          },
          "interval": {
            "type": "string",
            "example": "month"
          }
        }
      }
    }
  }
};

export const openapiYaml: string = "openapi: 3.1.0\ninfo:\n  title: ProAppStore Platform API\n  version: 1.0.0\n  description: 'REST API for ProAppStore (PAS) — the Pro app marketplace platform.\n\n\n    Powers identity, app provisioning + deploy, the per-app backend services (KV, counters, storage, rooms,\n    secrets, AI, email/SMS, maps, push), the storefront + submissions review flow, the Agent Teams build\n    loop, billing, and creator payouts.\n\n\n    Auth: send `Authorization: Bearer <PAS session JWT>` (HS256, from `/v1/auth/exchange` or an OAuth\n    flow). A handful of service-to-service routes use the `X-Internal-Token` header instead. Public routes\n    need no auth.\n\n\n    This spec is generated from the backend route table; request/response bodies are typed for the core\n    resources and generic (object) elsewhere.'\nservers:\n- url: https://api.proappstore.online\n  description: Production\nsecurity:\n- bearerAuth: []\ntags:\n- name: Health\n  description: ''\n- name: Auth\n  description: OAuth (GitHub/Google), credential, and session-exchange endpoints.\n- name: Billing\n  description: Pro subscription status, Stripe Checkout, and billing portal.\n- name: Apps\n  description: App listing and dashboard management.\n- name: Submissions\n  description: Pro app review flow (submit, list, approve/reject).\n- name: Provisioning\n  description: Provision app infrastructure (route + D1 + data worker).\n- name: Listings\n  description: Storefront publishing and the public storefront browse API.\n- name: Teams\n  description: App team membership and invites.\n- name: Invites\n  description: App invite links (create/list/redeem).\n- name: Roles\n  description: App-level custom roles and role checks.\n- name: Key Vault\n  description: Encrypted BYO API-key vault (AES-256-GCM) + proxy usage.\n- name: KV Storage\n  description: Per-app key-value storage.\n- name: Counters\n  description: Per-app integer counters.\n- name: Storage\n  description: R2-backed per-app file storage (private + public).\n- name: Tools\n  description: MCP tool registration per app (SQL-backed actions).\n- name: Actions\n  description: Execute custom per-app serverless actions.\n- name: Secrets\n  description: Per-app secret storage proxy.\n- name: Domains\n  description: Custom domain attach/verify/detach.\n- name: Stripe Connect\n  description: Creator payout onboarding via Stripe Connect.\n- name: Email\n  description: Transactional email delivery.\n- name: SMS\n  description: Twilio SMS delivery.\n- name: Notifications\n  description: Web Push subscriptions and delivery.\n- name: Analytics\n  description: Per-app usage analytics + the public instrumentation endpoints.\n- name: Usage\n  description: Per-user and per-app API usage tracking.\n- name: Payouts\n  description: Creator payout preview and the monthly payout cron.\n- name: Logs\n  description: Per-app build and runtime logs.\n- name: Maps\n  description: Geocoding, reverse-geocoding, and routing.\n- name: AI\n  description: Workers AI text generation, embeddings, and model listing.\n- name: App Webhooks\n  description: Per-app outbound webhook configuration.\n- name: Services\n  description: Creator services marketplace profiles, balance, earnings.\n- name: Engagements\n  description: Service engagements, messaging, and workspace.\n- name: Rooms\n  description: Realtime collaboration rooms (Durable Objects, WebSocket).\n- name: Webhooks\n  description: Inbound provider webhooks (Stripe). Signature-verified, not user-facing.\n- name: Licensing\n  description: Per-app license key issuance and validation.\npaths:\n  /:\n    get:\n      tags:\n      - Health\n      summary: Service health\n      operationId: get\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /health:\n    get:\n      tags:\n      - Health\n      summary: Health check\n      operationId: get_health\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/ai/embed:\n    post:\n      tags:\n      - AI\n      summary: Create embed\n      operationId: post_v1_ai_embed\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/ai/generate:\n    post:\n      tags:\n      - AI\n      summary: Create generate\n      operationId: post_v1_ai_generate\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/ai/models:\n    get:\n      tags:\n      - AI\n      summary: List models\n      operationId: get_v1_ai_models\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/analytics.js:\n    get:\n      tags:\n      - Analytics\n      summary: List analytics script\n      operationId: get_v1_analytics_js\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/analytics/admin/platform:\n    get:\n      tags:\n      - Analytics\n      summary: List platform\n      operationId: get_v1_analytics_admin_platform\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/analytics/event:\n    post:\n      tags:\n      - Analytics\n      summary: Event analytics\n      operationId: post_v1_analytics_event\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps:\n    get:\n      tags:\n      - Apps\n      summary: List apps\n      operationId: get_v1_apps\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/apps/{appId}/actions/{name}:\n    post:\n      tags:\n      - Actions\n      summary: Create actions\n      operationId: post_v1_apps_appId_actions_name\n      description: \"Run a registered action. Auth: a PAS session JWT, OR a personal app token `Authorization: Bearer pas_at_…` minted for THIS app (#154; roles fixed to `user`, read tokens may call query actions only, action-scoped tokens only their actions). Public actions (requires_auth false) need no auth. A `verify` action (#148) runs its scoped SELECT, hands the rows to the platform verifier named in its manifest (e.g. `chess.replay`), and — when the verifier completes — runs its write statements in one transaction with the verdict bound as `:__verify_<output>`; it answers `{ ok, verifier, output, error?, writes? }` (200 with `ok: false` and no write when the input could not be verified).\"\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/allowlist:\n    get:\n      tags:\n      - Secrets\n      summary: List allowlist\n      operationId: get_v1_apps_appId_allowlist\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    put:\n      tags:\n      - Secrets\n      summary: Set allowlist\n      operationId: put_v1_apps_appId_allowlist\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - Secrets\n      summary: Delete allowlist\n      operationId: delete_v1_apps_appId_allowlist\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/analytics:\n    get:\n      tags:\n      - Analytics\n      summary: List analytics\n      operationId: get_v1_apps_appId_analytics\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    put:\n      tags:\n      - Analytics\n      summary: Set analytics\n      operationId: put_v1_apps_appId_analytics\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/analytics/diagnostics:\n    get:\n      tags:\n      - Analytics\n      summary: List diagnostics\n      operationId: get_v1_apps_appId_analytics_diagnostics\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/analytics/events:\n    get:\n      tags:\n      - Analytics\n      summary: List events\n      operationId: get_v1_apps_appId_analytics_events\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/analytics/live:\n    get:\n      tags:\n      - Analytics\n      summary: List live\n      operationId: get_v1_apps_appId_analytics_live\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/analytics/stats:\n    get:\n      tags:\n      - Analytics\n      summary: List stats\n      operationId: get_v1_apps_appId_analytics_stats\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/counters:\n    get:\n      tags:\n      - Counters\n      summary: List counters\n      operationId: get_v1_apps_appId_counters\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/counters/{key}:\n    get:\n      tags:\n      - Counters\n      summary: Get counters\n      operationId: get_v1_apps_appId_counters_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: key\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - Counters\n      summary: Create counters\n      operationId: post_v1_apps_appId_counters_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: key\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/domains:\n    post:\n      tags:\n      - Domains\n      summary: Create domains\n      operationId: post_v1_apps_appId_domains\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Domains\n      summary: List domains\n      operationId: get_v1_apps_appId_domains\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/domains/{domain}:\n    delete:\n      tags:\n      - Domains\n      summary: Delete domains\n      operationId: delete_v1_apps_appId_domains_domain\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: domain\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/domains/{domain}/verify:\n    post:\n      tags:\n      - Domains\n      summary: Verify domains\n      operationId: post_v1_apps_appId_domains_domain_verify\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: domain\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/files:\n    get:\n      tags:\n      - Storage\n      summary: List files\n      operationId: get_v1_apps_appId_files\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/invites:\n    post:\n      tags:\n      - Invites\n      summary: Create invites\n      operationId: post_v1_apps_appId_invites\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Invites\n      summary: List invites\n      operationId: get_v1_apps_appId_invites\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/invites/{inviteId}:\n    delete:\n      tags:\n      - Invites\n      summary: Delete invites\n      operationId: delete_v1_apps_appId_invites_inviteId\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: inviteId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/kv:\n    get:\n      tags:\n      - KV Storage\n      summary: List kv\n      operationId: get_v1_apps_appId_kv\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/kv/{key}:\n    get:\n      tags:\n      - KV Storage\n      summary: Get kv\n      operationId: get_v1_apps_appId_kv_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: key\n        in: path\n        required: true\n        schema:\n          type: string\n    put:\n      tags:\n      - KV Storage\n      summary: Set kv\n      operationId: put_v1_apps_appId_kv_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: key\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - KV Storage\n      summary: Delete kv\n      operationId: delete_v1_apps_appId_kv_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: key\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/license:\n    get:\n      tags:\n      - Licensing\n      summary: List license\n      operationId: get_v1_apps_appId_license\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - Licensing\n      summary: Issue license\n      operationId: post_v1_apps_appId_license\n      description: Mint the caller's license key for this app, or return the existing live one (idempotent). Requires an active platform subscription. Keys are 256 random bits, base64url.\n      responses:\n        '200':\n          description: Existing license returned\n        '201':\n          description: New license issued\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          description: Subscription inactive\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    delete:\n      tags:\n      - Licensing\n      summary: Revoke license\n      operationId: delete_v1_apps_appId_license\n      description: Revoke the caller's own license key(s) for this app (for a leaked key). Returns the number revoked; POST mints a replacement.\n      responses:\n        '200':\n          description: Success\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/alerts:\n    get:\n      tags:\n      - Logs\n      summary: Operational alerts for an app (#107)\n      description: 'Owner only. Spikes the scheduled evaluator recorded from app_logs (client runtime errors, server-side action failures and 5xx) and QA runs: kind, window, count, affected users (a count), the previous window''s baseline, top categories / operations / fingerprints and build metadata. Never messages, request bodies, tokens or user ids. Query: since (ms, default 7 days), limit (≤ 200), open=1 for unacknowledged only.'\n      operationId: get_v1_apps_appId_alerts\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  alerts:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        id:\n                          type: integer\n                        app_id:\n                          type: string\n                        kind:\n                          type: string\n                          enum:\n                          - error_spike\n                          - action_failures\n                          - server_5xx\n                          - qa_failures\n                        window_start:\n                          type: integer\n                        window_end:\n                          type: integer\n                        count:\n                          type: integer\n                        affected_users:\n                          type: integer\n                          description: distinct sessions or anonymous client ids — a count, never a list\n                        baseline:\n                          type: integer\n                          description: the same measure in the previous window\n                        top:\n                          type: object\n                          properties:\n                            categories:\n                              type: array\n                              items:\n                                type: object\n                            operations:\n                              type: array\n                              items:\n                                type: object\n                            fingerprints:\n                              type: array\n                              items:\n                                type: object\n                        build:\n                          type: object\n                          nullable: true\n                        created_at:\n                          type: integer\n                        acknowledged_at:\n                          type: integer\n                          nullable: true\n                        acknowledged_by:\n                          type: string\n                          nullable: true\n                  since:\n                    type: integer\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/alerts/evaluate:\n    post:\n      tags:\n      - Logs\n      summary: Evaluate the alert thresholds for an app now (#107)\n      description: Owner only. Runs the same evaluation the 15-minute cron runs, scoped to this app, records any spike (idempotent per window) and returns the report.\n      operationId: post_v1_apps_appId_alerts_evaluate\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  checkedAt:\n                    type: string\n                  windowMs:\n                    type: integer\n                  alerts:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        id:\n                          type: integer\n                        app_id:\n                          type: string\n                        kind:\n                          type: string\n                          enum:\n                          - error_spike\n                          - action_failures\n                          - server_5xx\n                          - qa_failures\n                        window_start:\n                          type: integer\n                        window_end:\n                          type: integer\n                        count:\n                          type: integer\n                        affected_users:\n                          type: integer\n                          description: distinct sessions or anonymous client ids — a count, never a list\n                        baseline:\n                          type: integer\n                          description: the same measure in the previous window\n                        top:\n                          type: object\n                          properties:\n                            categories:\n                              type: array\n                              items:\n                                type: object\n                            operations:\n                              type: array\n                              items:\n                                type: object\n                            fingerprints:\n                              type: array\n                              items:\n                                type: object\n                        build:\n                          type: object\n                          nullable: true\n                        created_at:\n                          type: integer\n                        acknowledged_at:\n                          type: integer\n                          nullable: true\n                        acknowledged_by:\n                          type: string\n                          nullable: true\n                  recorded:\n                    type: integer\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/alerts/{id}/ack:\n    post:\n      tags:\n      - Logs\n      summary: Acknowledge an alert (#107)\n      operationId: post_v1_apps_appId_alerts_id_ack\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '404':\n          description: Not found or already acknowledged\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: integer\n  /v1/apps/{appId}/logs:\n    post:\n      tags:\n      - Logs\n      summary: Create logs\n      operationId: post_v1_apps_appId_logs\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Logs\n      summary: List logs\n      operationId: get_v1_apps_appId_logs\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/logs/build:\n    get:\n      tags:\n      - Logs\n      summary: List build\n      operationId: get_v1_apps_appId_logs_build\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/public/{path}:\n    get:\n      tags:\n      - Storage\n      summary: Get public\n      operationId: get_v1_apps_appId_public_path\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: path\n        in: path\n        required: true\n        schema:\n          type: string\n        description: Catch-all sub-path (may contain slashes).\n  /v1/apps/{appId}/roles:\n    get:\n      tags:\n      - Roles\n      summary: List roles\n      operationId: get_v1_apps_appId_roles\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - Roles\n      summary: Create roles\n      operationId: post_v1_apps_appId_roles\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - Roles\n      summary: Delete roles\n      operationId: delete_v1_apps_appId_roles\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/roles/check/{role}:\n    get:\n      tags:\n      - Roles\n      summary: Get check\n      operationId: get_v1_apps_appId_roles_check_role\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: role\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/roles/ensure-member:\n    post:\n      tags:\n      - Roles\n      summary: Create ensure member\n      operationId: post_v1_apps_appId_roles_ensure_member\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/roles/me:\n    get:\n      tags:\n      - Roles\n      summary: List me\n      operationId: get_v1_apps_appId_roles_me\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/rooms/{roomId}:\n    get:\n      tags:\n      - Rooms\n      summary: Get rooms\n      operationId: get_v1_apps_appId_rooms_roomId\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: roomId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/secrets:\n    get:\n      tags:\n      - Secrets\n      summary: List secrets\n      operationId: get_v1_apps_appId_secrets\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/secrets/{name}:\n    put:\n      tags:\n      - Secrets\n      summary: Set secrets\n      operationId: put_v1_apps_appId_secrets_name\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - Secrets\n      summary: Delete secrets\n      operationId: delete_v1_apps_appId_secrets_name\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/storage/{path}:\n    put:\n      tags:\n      - Storage\n      summary: Set storage\n      operationId: put_v1_apps_appId_storage_path\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: path\n        in: path\n        required: true\n        schema:\n          type: string\n        description: Catch-all sub-path (may contain slashes).\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Storage\n      summary: Get storage\n      operationId: get_v1_apps_appId_storage_path\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: path\n        in: path\n        required: true\n        schema:\n          type: string\n        description: Catch-all sub-path (may contain slashes).\n    delete:\n      tags:\n      - Storage\n      summary: Delete storage\n      operationId: delete_v1_apps_appId_storage_path\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: path\n        in: path\n        required: true\n        schema:\n          type: string\n        description: Catch-all sub-path (may contain slashes).\n  /v1/apps/{appId}/team:\n    get:\n      tags:\n      - Teams\n      summary: List team\n      operationId: get_v1_apps_appId_team\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/team/invite:\n    post:\n      tags:\n      - Teams\n      summary: Create invite\n      operationId: post_v1_apps_appId_team_invite\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/team/{userRef}:\n    put:\n      tags:\n      - Teams\n      summary: Set team\n      operationId: put_v1_apps_appId_team_userRef\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: userRef\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - Teams\n      summary: Delete team\n      operationId: delete_v1_apps_appId_team_userRef\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: userRef\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/tokens:\n    post:\n      tags:\n      - Tokens\n      summary: Mint a personal app token (#154)\n      description: Session only (a pas_at_ token can never manage tokens). Returns the plaintext `pas_at_…` token ONCE; only its SHA-256 is stored. `access` and `expires_in` (seconds) are required. Lifetime is capped at 90 days when the request Origin is an app origin, 365 days from a first-party origin or no Origin — no token is non-expiring. `actions` restricts the token to named actions, each of which must exist for the app.\n      operationId: post_v1_apps_appId_tokens\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n              - access\n              - expires_in\n              properties:\n                label:\n                  type: string\n                expires_in:\n                  type: integer\n                  description: Lifetime in seconds (min 60)\n                access:\n                  type: string\n                  enum:\n                  - read\n                  - write\n                actions:\n                  type: array\n                  items:\n                    type: string\n                  maxItems: 50\n      responses:\n        '201':\n          description: Created\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  token:\n                    type: string\n                    description: pas_at_… — shown once\n                  token_id:\n                    type: string\n                  app_id:\n                    type: string\n                  label:\n                    type: string\n                    nullable: true\n                  access:\n                    type: string\n                  actions:\n                    type: array\n                    items:\n                      type: string\n                    nullable: true\n                  created_origin:\n                    type: string\n                    nullable: true\n                  created_at:\n                    type: integer\n                  expires_at:\n                    type: integer\n                  note:\n                    type: string\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '404':\n          description: App not found\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    get:\n      tags:\n      - Tokens\n      summary: List my tokens for an app (#154)\n      description: Never returns the token or its hash.\n      operationId: get_v1_apps_appId_tokens\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  tokens:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        token_id:\n                          type: string\n                        app_id:\n                          type: string\n                        label:\n                          type: string\n                          nullable: true\n                        access:\n                          type: string\n                          enum:\n                          - read\n                          - write\n                        actions:\n                          type: array\n                          items:\n                            type: string\n                          nullable: true\n                        created_origin:\n                          type: string\n                          nullable: true\n                        created_at:\n                          type: integer\n                        last_used_at:\n                          type: integer\n                          nullable: true\n                        expires_at:\n                          type: integer\n                        expired:\n                          type: boolean\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/tokens/{tokenId}:\n    delete:\n      tags:\n      - Tokens\n      summary: Revoke one of my tokens (#154)\n      description: Exact match on token id + caller + app; another user's token id is 404.\n      operationId: delete_v1_apps_appId_tokens_tokenId\n      responses:\n        '200':\n          description: Success\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '404':\n          description: Token not found\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: tokenId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/me/tokens:\n    get:\n      tags:\n      - Tokens\n      summary: Every token I hold across apps (#154)\n      description: 'For the dashboard: app id, label, scopes, origin, created / last used / expiry, so a token minted by an app can always be found and revoked from a surface the creator does not control.'\n      operationId: get_v1_me_tokens\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  tokens:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        token_id:\n                          type: string\n                        app_id:\n                          type: string\n                        label:\n                          type: string\n                          nullable: true\n                        access:\n                          type: string\n                          enum:\n                          - read\n                          - write\n                        actions:\n                          type: array\n                          items:\n                            type: string\n                          nullable: true\n                        created_origin:\n                          type: string\n                          nullable: true\n                        created_at:\n                          type: integer\n                        last_used_at:\n                          type: integer\n                          nullable: true\n                        expires_at:\n                          type: integer\n                        expired:\n                          type: boolean\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/apps/{appId}/tools:\n    put:\n      tags:\n      - Tools\n      summary: Set tools\n      operationId: put_v1_apps_appId_tools\n      responses:\n        '200':\n          description: Registered. Reports the manifest's model-facing byte cost (name + description + params, never SQL) beside the count, and a soft warning above 50 000 bytes (#117).\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/ToolRegistrationResult'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Tools\n      summary: List tools\n      operationId: get_v1_apps_appId_tools\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    delete:\n      tags:\n      - Tools\n      summary: Delete tools\n      operationId: delete_v1_apps_appId_tools\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/endpoints:\n    get:\n      tags:\n      - Tools\n      summary: List console-defined endpoints (#155)\n      description: 'Owner only. Endpoints built in the console (names api_*), stored beside code tools under source = ''console''. status re-runs schema coherence: a column dropped by a later migration reads ''broken'' with the error.'\n      operationId: get_v1_apps_appId_endpoints\n      responses:\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  endpoints:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        name:\n                          type: string\n                        config:\n                          type: object\n                        manifest:\n                          type: object\n                        updated_at:\n                          type: integer\n                        updated_by:\n                          type: string\n                        status:\n                          type: string\n                          enum:\n                          - ok\n                          - broken\n                        error:\n                          type: string\n        '403':\n          $ref: '#/components/responses/Forbidden'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/endpoints/preview:\n    post:\n      tags:\n      - Tools\n      summary: Preview the manifest a config would generate (#155)\n      description: Owner only. Reads the table schema from the app's data worker, generates the SQL and runs the same validators as mcp.json registration. Nothing is saved.\n      operationId: post_v1_apps_appId_endpoints_preview\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n              - config\n              properties:\n                config:\n                  type: object\n                  description: 'EndpointConfig: name (api_…), description, kind (read|insert), table, scope (own|all|public), owner_column, columns, filters, sort, page_size, paginate, generated, defaults, app_roles. Never SQL.'\n      responses:\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  manifest:\n                    type: object\n        '400':\n          description: 'Invalid config: { error, details }'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '422':\n          description: 'Schema coherence: the generated SQL references a missing table or column'\n        '503':\n          description: The app schema could not be read from its data worker\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/endpoints/{name}:\n    put:\n      tags:\n      - Tools\n      summary: Create or update a console-defined endpoint (#155)\n      description: Owner only; a personal app token is rejected. Writes the app_tools row (source = 'console') and its app_endpoint_audit entry in one batch. Console endpoints survive deploys; max 30 per app.\n      operationId: put_v1_apps_appId_endpoints_name\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n              - config\n              properties:\n                config:\n                  type: object\n                  description: 'EndpointConfig: name (api_…), description, kind (read|insert), table, scope (own|all|public), owner_column, columns, filters, sort, page_size, paginate, generated, defaults, app_roles. Never SQL.'\n      responses:\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  endpoint:\n                    type: object\n        '400':\n          description: Invalid config, prefix missing, or console cap reached\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '409':\n          description: The name is registered by the app's code (mcp.json)\n        '422':\n          description: Schema coherence failure\n        '503':\n          description: The app schema could not be read\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n    delete:\n      tags:\n      - Tools\n      summary: Delete a console-defined endpoint (#155)\n      description: Owner only. Removes source = 'console' rows only, audited. Code tools are managed by deploys.\n      operationId: delete_v1_apps_appId_endpoints_name\n      responses:\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '200':\n          description: Success\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '404':\n          description: No console endpoint with that name\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/tools/internal:\n    post:\n      tags:\n      - Tools\n      summary: Create internal\n      operationId: post_v1_apps_appId_tools_internal\n      responses:\n        '200':\n          description: Registered — same result shape as PUT /v1/apps/{appId}/tools (#117).\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/ToolRegistrationResult'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/tools/{name}:\n    delete:\n      tags:\n      - Tools\n      summary: Delete tools\n      operationId: delete_v1_apps_appId_tools_name\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: name\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/webhooks:\n    get:\n      tags:\n      - App Webhooks\n      summary: List webhooks\n      operationId: get_v1_apps_appId_webhooks\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - App Webhooks\n      summary: Create webhooks\n      operationId: post_v1_apps_appId_webhooks\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{appId}/webhooks/{id}:\n    delete:\n      tags:\n      - App Webhooks\n      summary: Delete webhooks\n      operationId: delete_v1_apps_appId_webhooks_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{appId}/webhooks/{id}/test:\n    post:\n      tags:\n      - App Webhooks\n      summary: Test webhooks\n      operationId: post_v1_apps_appId_webhooks_id_test\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{id}:\n    delete:\n      tags:\n      - Apps\n      summary: Delete apps\n      operationId: delete_v1_apps_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/apps/{id}/listing:\n    get:\n      tags:\n      - Listings\n      summary: List listing\n      operationId: get_v1_apps_id_listing\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n    put:\n      tags:\n      - Listings\n      summary: Set listing\n      operationId: put_v1_apps_id_listing\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{id}/listing-assets/{kind}:\n    put:\n      tags:\n      - Listings\n      summary: Set listing assets\n      operationId: put_v1_apps_id_listing_assets_kind\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      - name: kind\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/apps/{id}/usage:\n    get:\n      tags:\n      - Usage\n      summary: List usage\n      operationId: get_v1_apps_id_usage\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/auth/credentials/change-password:\n    post:\n      tags:\n      - Auth\n      summary: Change Password credentials\n      operationId: post_v1_auth_credentials_change_password\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/turnstile:\n    get:\n      tags:\n      - Auth\n      summary: Turnstile config for sign-up forms (#26)\n      operationId: get_v1_auth_turnstile\n      description: Anonymous, cacheable (5 min). `siteKey` is the public Turnstile widget site key when the bot check is enforced on POST /v1/auth/credentials/register (both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY set on the API), else null — render the widget only when non-null, with data-action = `action` (`register`). Hosted apps read it as /.pas/auth/turnstile on their origin (SDK `auth.turnstileSiteKey()`).\n      responses:\n        '200':\n          description: Success\n  /v1/auth/credentials/login:\n    post:\n      tags:\n      - Auth\n      summary: Create login\n      operationId: post_v1_auth_credentials_login\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/credentials/provision:\n    post:\n      tags:\n      - Auth\n      summary: Provision credentials\n      operationId: post_v1_auth_credentials_provision\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/credentials/register:\n    post:\n      tags:\n      - Auth\n      summary: Self-service registration for a credential account (#118)\n      description: 'Anonymous. Creates an adult credential account (id cred:<uuid>, provider credential, is_child 0, created_by null) from an email + password. Always answers 202 { ok: true }: for a new address the account is created; for an already-registered address nothing changes and, when a sender is configured, that address is emailed a notice — no enumeration, and both paths hash the password. No session is minted: sign in through POST /v1/auth/credentials/login with the email. Policy: 12+ characters, common passwords refused. Rate-limited per client address (10 per 15 minutes) independently of the per-login lockout. Disabled when CREDENTIAL_SELF_REGISTRATION=0 (403). Bot check (#26): when Turnstile is configured on the API the request must carry a widget token minted with action `register` — `turnstileToken` body field or `CF-Turnstile-Response` header — verified before anything else; 403 `bot check required` / `bot check failed`, 503 `bot check unavailable`. GET /v1/auth/turnstile says whether it is on. Browser apps use the SDK''s auth.register(), which goes through /.pas/auth/credentials/register on the app origin.'\n      operationId: post_v1_auth_credentials_register\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n              - email\n              - password\n              properties:\n                email:\n                  type: string\n                  format: email\n                password:\n                  type: string\n                  minLength: 12\n                  maxLength: 256\n                displayName:\n                  type: string\n                  maxLength: 80\n      responses:\n        '202':\n          description: Accepted — the account exists now, or existed already (indistinguishable by design)\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  ok:\n                    type: boolean\n        '400':\n          description: Invalid email, or the password fails the policy (the message says which)\n        '403':\n          description: Self-registration is disabled on this platform\n        '429':\n          description: Too many registrations from this address\n      security: []\n  /v1/auth/credentials/reset-password:\n    post:\n      tags:\n      - Auth\n      summary: Reset Password credentials\n      operationId: post_v1_auth_credentials_reset_password\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/email/start:\n    post:\n      tags:\n      - Auth\n      summary: Start email\n      operationId: post_v1_auth_email_start\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/exchange/oidc:\n    post:\n      tags:\n      - Auth\n      summary: Exchange a GitHub Actions OIDC token for an e2e session (#146)\n      description: 'Keyless CI sessions. Bearer: the workflow''s OIDC token (audience https://api.proappstore.online), verified RS256 against GitHub''s JWKS with issuer, audience and expiry checks. A platform admin must first grant the repository (optionally one workflow, on one ref) the right to mint sessions for a designated e2e account; no grant → 403. The session lasts 4 hours, carries via: ''oidc-e2e'', has roles user + creator and never admin. Every mint is recorded.'\n      operationId: post_v1_auth_exchange_oidc\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  sessionToken:\n                    type: string\n                  expiresAt:\n                    type: integer\n                  via:\n                    type: string\n                    enum:\n                    - oidc-e2e\n                  grant:\n                    type: object\n                  user:\n                    type: object\n                    properties:\n                      id:\n                        type: string\n                      login:\n                        type: string\n                      avatarUrl:\n                        type: string\n                        nullable: true\n        '401':\n          description: Missing or invalid OIDC token\n        '403':\n          description: No matching grant (repository / workflow / ref), foreign org, or the granted account no longer exists\n      security:\n      - githubOidc: []\n  /v1/admin/oidc-session-grants:\n    get:\n      tags:\n      - Auth\n      summary: 'List e2e session grants (platform admin, #146)'\n      operationId: get_v1_admin_oidc_session_grants\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  grants:\n                    type: array\n                    items:\n                      type: object\n                      properties:\n                        id:\n                          type: string\n                        repository:\n                          type: string\n                        workflow:\n                          type: string\n                          nullable: true\n                        ref:\n                          type: string\n                        user_id:\n                          type: string\n                        label:\n                          type: string\n                          nullable: true\n                        created_by:\n                          type: string\n                        created_at:\n                          type: integer\n                        revoked_at:\n                          type: integer\n                          nullable: true\n                        last_minted_at:\n                          type: integer\n                          nullable: true\n                        mint_count:\n                          type: integer\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n      security:\n      - bearerAuth: []\n    post:\n      tags:\n      - Auth\n      summary: 'Grant a repository the right to mint e2e sessions for an account (platform admin, #146)'\n      operationId: post_v1_admin_oidc_session_grants\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required:\n              - repository\n              - user_id\n              properties:\n                repository:\n                  type: string\n                  description: proappstore-online/<repo>\n                user_id:\n                  type: string\n                  description: gh:<id> — must have signed in once\n                workflow:\n                  type: string\n                  description: .github/workflows/<file>.yml; omit for any workflow of the repo\n                ref:\n                  type: string\n                  default: refs/heads/main\n                label:\n                  type: string\n      responses:\n        '201':\n          description: Created\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  grant:\n                    type: object\n                    properties:\n                      id:\n                        type: string\n                      repository:\n                        type: string\n                      workflow:\n                        type: string\n                        nullable: true\n                      ref:\n                        type: string\n                      user_id:\n                        type: string\n                      label:\n                        type: string\n                        nullable: true\n                      created_by:\n                        type: string\n                      created_at:\n                        type: integer\n                      revoked_at:\n                        type: integer\n                        nullable: true\n                      last_minted_at:\n                        type: integer\n                        nullable: true\n                      mint_count:\n                        type: integer\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '404':\n          description: The account does not exist\n      security:\n      - bearerAuth: []\n  /v1/admin/oidc-session-grants/{id}:\n    delete:\n      tags:\n      - Auth\n      summary: 'Revoke an e2e session grant (platform admin, #146)'\n      operationId: delete_v1_admin_oidc_session_grants_id\n      responses:\n        '200':\n          description: Success\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          $ref: '#/components/responses/Forbidden'\n        '404':\n          description: Grant not found or already revoked\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/auth/exchange:\n    post:\n      tags:\n      - Auth\n      summary: Create exchange\n      operationId: post_v1_auth_exchange\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/me:\n    get:\n      tags:\n      - Auth\n      summary: List me\n      operationId: get_v1_auth_me\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/User'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/auth/me/date-of-birth:\n    patch:\n      tags:\n      - Auth\n      summary: Update date of birth\n      operationId: patch_v1_auth_me_date_of_birth\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: false\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/auth/{provider}/callback:\n    get:\n      tags:\n      - Auth\n      summary: List callback\n      operationId: get_v1_auth_provider_callback\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      parameters:\n      - name: provider\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/auth/{provider}/start:\n    get:\n      tags:\n      - Auth\n      summary: List start\n      operationId: get_v1_auth_provider_start\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      parameters:\n      - name: provider\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/checkout:\n    post:\n      tags:\n      - Billing\n      summary: Create checkout\n      operationId: post_v1_checkout\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/connect/onboard:\n    post:\n      tags:\n      - Stripe Connect\n      summary: Onboard connect\n      operationId: post_v1_connect_onboard\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/connect/status:\n    get:\n      tags:\n      - Stripe Connect\n      summary: List status\n      operationId: get_v1_connect_status\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/email/send:\n    post:\n      tags:\n      - Email\n      summary: Send email\n      operationId: post_v1_email_send\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/internal/apps/{appId}/analytics/cf-token:\n    put:\n      tags:\n      - Analytics\n      summary: Set cf token\n      operationId: put_v1_internal_apps_appId_analytics_cf_token\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      parameters:\n      - name: appId\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/internal/payouts/run:\n    post:\n      tags:\n      - Payouts\n      summary: Run payouts\n      operationId: post_v1_internal_payouts_run\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/invites/{code}/redeem:\n    post:\n      tags:\n      - Invites\n      summary: Redeem invites\n      operationId: post_v1_invites_code_redeem\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: code\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/keys:\n    get:\n      tags:\n      - Key Vault\n      summary: List keys\n      operationId: get_v1_keys\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/keys/providers:\n    get:\n      tags:\n      - Key Vault\n      summary: List providers\n      operationId: get_v1_keys_providers\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/keys/resolve/{provider}:\n    get:\n      tags:\n      - Key Vault\n      summary: Get resolve\n      operationId: get_v1_keys_resolve_provider\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      - internalToken: []\n      parameters:\n      - name: provider\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/keys/status:\n    get:\n      tags:\n      - Key Vault\n      summary: List status\n      operationId: get_v1_keys_status\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/keys/usage:\n    get:\n      tags:\n      - Key Vault\n      summary: List usage\n      operationId: get_v1_keys_usage\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/keys/{provider}:\n    put:\n      tags:\n      - Key Vault\n      summary: Set keys\n      operationId: put_v1_keys_provider\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: provider\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    delete:\n      tags:\n      - Key Vault\n      summary: Delete keys\n      operationId: delete_v1_keys_provider\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: provider\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/license/validate:\n    post:\n      tags:\n      - Licensing\n      summary: Validate license\n      operationId: post_v1_license_validate\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/maps/geocode:\n    get:\n      tags:\n      - Maps\n      summary: List geocode\n      operationId: get_v1_maps_geocode\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/maps/reverse:\n    get:\n      tags:\n      - Maps\n      summary: List reverse\n      operationId: get_v1_maps_reverse\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/maps/route:\n    get:\n      tags:\n      - Maps\n      summary: List route\n      operationId: get_v1_maps_route\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/me/is-admin:\n    get:\n      tags:\n      - Submissions\n      summary: List is admin\n      operationId: get_v1_me_is_admin\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/notifications/notify-user:\n    post:\n      tags:\n      - Notifications\n      summary: Notify User notifications\n      operationId: post_v1_notifications_notify_user\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/notifications/send:\n    post:\n      tags:\n      - Notifications\n      summary: Send notifications\n      operationId: post_v1_notifications_send\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/notifications/subscribe:\n    post:\n      tags:\n      - Notifications\n      summary: Subscribe notifications\n      operationId: post_v1_notifications_subscribe\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/notifications/unsubscribe:\n    post:\n      tags:\n      - Notifications\n      summary: Unsubscribe notifications\n      operationId: post_v1_notifications_unsubscribe\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/notifications/vapid-key:\n    get:\n      tags:\n      - Notifications\n      summary: List vapid key\n      operationId: get_v1_notifications_vapid_key\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/payouts/me/preview:\n    get:\n      tags:\n      - Payouts\n      summary: List preview\n      operationId: get_v1_payouts_me_preview\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/portal:\n    post:\n      tags:\n      - Billing\n      summary: Create portal\n      operationId: post_v1_portal\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/pricing:\n    get:\n      tags:\n      - Billing\n      summary: List pricing\n      operationId: get_v1_pricing\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Pricing'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/provision:\n    post:\n      tags:\n      - Provisioning\n      summary: Provision\n      operationId: post_v1_provision\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/provision-data:\n    post:\n      tags:\n      - Provisioning\n      summary: Create provision data\n      operationId: post_v1_provision_data\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/balance:\n    get:\n      tags:\n      - Services\n      summary: List balance\n      operationId: get_v1_services_balance\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/balance/confirm:\n    post:\n      tags:\n      - Services\n      summary: Confirm balance\n      operationId: post_v1_services_balance_confirm\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/balance/deposit:\n    post:\n      tags:\n      - Services\n      summary: Deposit balance\n      operationId: post_v1_services_balance_deposit\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/balance/transactions:\n    get:\n      tags:\n      - Services\n      summary: List transactions\n      operationId: get_v1_services_balance_transactions\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/developers:\n    get:\n      tags:\n      - Services\n      summary: List developers\n      operationId: get_v1_services_developers\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/developers/{id}:\n    get:\n      tags:\n      - Services\n      summary: Get developers\n      operationId: get_v1_services_developers_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/services/earnings:\n    get:\n      tags:\n      - Services\n      summary: List earnings\n      operationId: get_v1_services_earnings\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/engagements:\n    post:\n      tags:\n      - Engagements\n      summary: Create engagements\n      operationId: post_v1_services_engagements\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Engagements\n      summary: List engagements\n      operationId: get_v1_services_engagements\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/engagements/{id}:\n    get:\n      tags:\n      - Engagements\n      summary: Get engagements\n      operationId: get_v1_services_engagements_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n    patch:\n      tags:\n      - Engagements\n      summary: Update engagements\n      operationId: patch_v1_services_engagements_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: false\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/engagements/{id}/messages:\n    get:\n      tags:\n      - Engagements\n      summary: List messages\n      operationId: get_v1_services_engagements_id_messages\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - Engagements\n      summary: Create messages\n      operationId: post_v1_services_engagements_id_messages\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/engagements/{id}/rate:\n    post:\n      tags:\n      - Engagements\n      summary: Rate engagements\n      operationId: post_v1_services_engagements_id_rate\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/engagements/{id}/read:\n    post:\n      tags:\n      - Engagements\n      summary: Read engagements\n      operationId: post_v1_services_engagements_id_read\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/engagements/{id}/refund:\n    post:\n      tags:\n      - Engagements\n      summary: Refund engagements\n      operationId: post_v1_services_engagements_id_refund\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/engagements/{id}/workspace:\n    get:\n      tags:\n      - Engagements\n      summary: List workspace\n      operationId: get_v1_services_engagements_id_workspace\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n    post:\n      tags:\n      - Engagements\n      summary: Create workspace\n      operationId: post_v1_services_engagements_id_workspace\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/my-requests:\n    get:\n      tags:\n      - Services\n      summary: List my requests\n      operationId: get_v1_services_my_requests\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/profile:\n    get:\n      tags:\n      - Services\n      summary: List profile\n      operationId: get_v1_services_profile\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n    put:\n      tags:\n      - Services\n      summary: Set profile\n      operationId: put_v1_services_profile\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/profile/availability:\n    patch:\n      tags:\n      - Services\n      summary: Update availability\n      operationId: patch_v1_services_profile_availability\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: false\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/recompute-stats:\n    post:\n      tags:\n      - Services\n      summary: Recompute Stats services\n      operationId: post_v1_services_recompute_stats\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - internalToken: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/requests:\n    post:\n      tags:\n      - Engagements\n      summary: Create requests\n      operationId: post_v1_services_requests\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Engagements\n      summary: List requests\n      operationId: get_v1_services_requests\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/services/requests/{id}:\n    delete:\n      tags:\n      - Engagements\n      summary: Delete requests\n      operationId: delete_v1_services_requests_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/services/requests/{id}/accept:\n    post:\n      tags:\n      - Engagements\n      summary: Accept requests\n      operationId: post_v1_services_requests_id_accept\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/services/unread:\n    get:\n      tags:\n      - Engagements\n      summary: List unread\n      operationId: get_v1_services_unread\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/sms/send:\n    post:\n      tags:\n      - SMS\n      summary: Send sms\n      operationId: post_v1_sms_send\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/storefront/apps:\n    get:\n      tags:\n      - Listings\n      summary: List apps\n      operationId: get_v1_storefront_apps\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n  /v1/storefront/apps/{id}:\n    get:\n      tags:\n      - Listings\n      summary: Get apps\n      operationId: get_v1_storefront_apps_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/submissions:\n    post:\n      tags:\n      - Submissions\n      summary: Create submissions\n      operationId: post_v1_submissions\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n    get:\n      tags:\n      - Submissions\n      summary: List submissions\n      operationId: get_v1_submissions\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/submissions/{id}:\n    get:\n      tags:\n      - Submissions\n      summary: Get submissions\n      operationId: get_v1_submissions_id\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Submission'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n    delete:\n      tags:\n      - Submissions\n      summary: Delete submissions\n      operationId: delete_v1_submissions_id\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n  /v1/submissions/{id}/approve:\n    post:\n      tags:\n      - Submissions\n      summary: Approve submissions\n      operationId: post_v1_submissions_id_approve\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/submissions/{id}/reject:\n    post:\n      tags:\n      - Submissions\n      summary: Reject submissions\n      operationId: post_v1_submissions_id_reject\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n      parameters:\n      - name: id\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/subscription:\n    get:\n      tags:\n      - Billing\n      summary: List subscription\n      operationId: get_v1_subscription\n      responses:\n        '200':\n          description: Success\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Subscription'\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/team/accept/{token}:\n    post:\n      tags:\n      - Teams\n      summary: Create accept\n      operationId: post_v1_team_accept_token\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      parameters:\n      - name: token\n        in: path\n        required: true\n        schema:\n          type: string\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /v1/usage/me:\n    get:\n      tags:\n      - Usage\n      summary: List me\n      operationId: get_v1_usage_me\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/usage/owner-summary:\n    get:\n      tags:\n      - Usage\n      summary: List owner summary\n      operationId: get_v1_usage_owner_summary\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n      security:\n      - bearerAuth: []\n  /v1/usage/ping:\n    post:\n      tags:\n      - Usage\n      summary: Ping usage\n      description: 'Records session_seconds/api_calls for (app, user, day). Attribution is bound to the app origin the host asserts (X-PAS-App, set by platform mediation): a mismatch with the body''s appId is refused (403); a ping without the mediated origin (direct API call, legacy-bearer SDK) is acknowledged with recorded=false and not stored; only active subscribers'' usage is recorded (#58).'\n      operationId: post_v1_usage_ping\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n        '401':\n          $ref: '#/components/responses/Unauthorized'\n        '403':\n          description: app context mismatch (the mediated origin names a different app than the body)\n      security:\n      - bearerAuth: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n  /webhooks/stripe:\n    post:\n      tags:\n      - Webhooks\n      summary: Create stripe\n      operationId: post_webhooks_stripe\n      responses:\n        '200':\n          description: Success\n        '400':\n          $ref: '#/components/responses/BadRequest'\n      security: []\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\ncomponents:\n  securitySchemes:\n    githubOidc:\n      type: http\n      scheme: bearer\n      bearerFormat: GitHub Actions OIDC JWT\n      description: 'A GitHub Actions OIDC token (permissions: id-token: write; audience https://api.proappstore.online). Accepted by the keyless deploy routes and POST /v1/auth/exchange/oidc.'\n    appToken:\n      type: http\n      scheme: bearer\n      bearerFormat: pas_at_…\n      description: 'Personal app token (#154): per-user, per-app, revocable; accepted by POST /v1/apps/{appId}/actions/{name} only. Never by MCP or any other route.'\n    bearerAuth:\n      type: http\n      scheme: bearer\n      bearerFormat: JWT\n      description: PAS session JWT (HS256). uid/login/roles claims.\n    internalToken:\n      type: apiKey\n      in: header\n      name: X-Internal-Token\n      description: Shared secret for service-to-service calls.\n  responses:\n    BadRequest:\n      description: Invalid request\n      content:\n        application/json:\n          schema:\n            $ref: '#/components/schemas/Error'\n    Unauthorized:\n      description: Missing or invalid token\n      content:\n        application/json:\n          schema:\n            $ref: '#/components/schemas/Error'\n  schemas:\n    ToolRegistrationResult:\n      type: object\n      required: [ok, registered, bytes, bytesPerTool, estimatedTokens, warnings]\n      properties:\n        ok:\n          type: boolean\n        registered:\n          type: integer\n          description: Number of tools now registered for the app.\n        bytes:\n          type: integer\n          description: Model-facing payload of the whole manifest — name, description and params per tool, never SQL — in UTF-8 bytes (#117).\n        bytesPerTool:\n          type: number\n          description: bytes / registered, rounded.\n        estimatedTokens:\n          type: integer\n          description: bytes / 4, rounded — a rule-of-thumb token occupancy per MCP call, not a tokenizer.\n        warnings:\n          type: array\n          items:\n            type: string\n          description: Empty when under the 50 000-byte soft threshold; otherwise one message naming the cost. Never a rejection.\n    Error:\n      type: object\n      properties:\n        error:\n          type: string\n      required:\n      - error\n    User:\n      type: object\n      properties:\n        uid:\n          type: string\n          description: e.g. gh:123 | google:123 | cred:uuid\n        login:\n          type: string\n        avatarUrl:\n          type: string\n        roles:\n          type: array\n          items:\n            type: string\n            enum:\n            - user\n            - creator\n            - admin\n    App:\n      type: object\n      properties:\n        id:\n          type: string\n        creator_id:\n          type: string\n        d1_database_id:\n          type: string\n        created_at:\n          type: string\n          format: date-time\n    Submission:\n      type: object\n      properties:\n        id:\n          type: string\n        app_id:\n          type: string\n        creator_id:\n          type: string\n        status:\n          type: string\n          enum:\n          - pending\n          - approved\n          - rejected\n        name:\n          type: string\n        category:\n          type: string\n        description:\n          type: string\n        suggested_monthly_price_cents:\n          type: integer\n        repo_url:\n          type: string\n        created_at:\n          type: string\n          format: date-time\n    Subscription:\n      type: object\n      properties:\n        status:\n          type: string\n          enum:\n          - active\n          - trialing\n          - past_due\n          - canceled\n          - none\n        tier:\n          type: string\n        current_period_end:\n          type: integer\n        cancel_at_period_end:\n          type: boolean\n    Pricing:\n      type: object\n      properties:\n        price_cents:\n          type: integer\n          example: 900\n        currency:\n          type: string\n          example: usd\n        interval:\n          type: string\n          example: month\n";
