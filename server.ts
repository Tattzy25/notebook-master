import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// ========================================== //
// CONSTANTS & DISPATCHER IMPLEMENTATION      //
// ========================================== //
const HOSTED_SHOP_MCP_URL = "https://mcp.shop.com/";

interface McpDispatchOptions {
  toolName: string;
  args: Record<string, unknown>;
  authToken?: string;
}

/**
 * FIXED: Universal Dispatcher targeting official hosted Shop MCP infrastructure
 * - Injects mandatory transport headers (MCP-Protocol-Version, Mcp-Method, Mcp-Name)
 * - Implements case-insensitive Bearer token extraction for signed-in tools
 * - Supports meta.idempotency-key forwarding across write operations
 * - Handles JSON-RPC errors and HTTP 401 authentication challenges cleanly
 */
async function dispatchToShopMcp({ toolName, args, authToken }: McpDispatchOptions) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": toolName,
  };

  if (authToken) {
    headers["Authorization"] = authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`;
  }

  const response = await fetch(HOSTED_SHOP_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "remediated-shop-mcp-bridge", version: "2.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  });

  if (response.status === 401) {
    return {
      isError: true,
      content: [{ type: "text", text: "Authentication required: Missing or invalid personal_agent access token." }],
      _meta: { "com.shopify/error": { code: "sign_in_required" }, "com.shopify/upstream_status": 401 }
    };
  }

  if (!response.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Shop MCP Gateway HTTP ${response.status}` }],
      _meta: { "com.shopify/error": { code: "upstream_unavailable" }, "com.shopify/upstream_status": response.status }
    };
  }

  const json = await response.json() as any;
  if (json.error) {
    return {
      isError: true,
      content: [{ type: "text", text: json.error.message }],
      _meta: { "com.shopify/error": { code: "upstream_error", upstream_code: json.error.code } }
    };
  }

  return json.result;
}

/**
 * FIXED: Helper function for case-insensitive Authorization header extraction
 */
function extractAuthToken(extra: any): string | undefined {
  const headers = extra?.requestInfo?.headers;
  if (!headers) return undefined;
  return headers["authorization"] || headers["Authorization"] || headers["AUTHORIZATION"];
}

// ========================================== //
// CANONICAL ZOD SCHEMAS (18 TOOLS)           //
// ========================================== //

// 1. CATALOG SCHEMAS
// FIXED: Complete schema including attributes, ships_to, ships_from, categories, condition, price_tier, rating, and query/like refinement
const searchCatalogSchema = z.object({
  catalog: z.object({
    query: z.string().optional(),
    like: z.array(z.object({
      id: z.string().optional(),
      image: z.object({ content_type: z.string(), data: z.string() }).optional()
    })).optional(),
    context: z.object({
      address_country: z.string().length(2).optional(),
      address_region: z.string().optional(),
      postal_code: z.string().optional(),
      currency: z.string().length(3).optional(),
      language: z.string().optional(),
      intent: z.string().optional()
    }).optional(),
    filters: z.object({
      attributes: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).optional(),
      price: z.object({ min: z.number().int().optional(), max: z.number().int().optional() }).optional(),
      ships_to: z.object({ country: z.string().length(2), region: z.string().optional(), postal_code: z.string().optional() }).optional(),
      ships_from: z.array(z.object({ country: z.string().length(2) })).optional(),
      shops: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
      condition: z.array(z.enum(["new", "secondhand"])).optional(),
      price_tier: z.array(z.string()).optional(),
      rating: z.object({ variant: z.object({ min: z.number(), min_count: z.number().int() }) }).optional(),
      available: z.boolean().optional()
    }).optional(),
    pagination: z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional()
    }).optional(),
    signals: z.record(z.unknown()).optional()
  }).refine(data => data.query || (data.like && data.like.length > 0), {
    message: "Either catalog.query or catalog.like must be provided."
  })
});

const lookupCatalogSchema = z.object({
  catalog: z.object({
    ids: z.array(z.string()).min(1).max(50),
    context: z.object({
      address_country: z.string().length(2).optional(),
      currency: z.string().length(3).optional()
    }).optional(),
    filters: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional()
  })
});

const getProductSchema = z.object({
  catalog: z.object({
    id: z.string().describe("Product or variant GID"),
    selected: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
    preferences: z.array(z.string()).optional(),
    context: z.object({
      address_country: z.string().length(2).optional(),
      currency: z.string().length(3).optional()
    }).optional(),
    filters: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional()
  })
});

// 2. LOCATION DIRECTORY SCHEMAS
const searchLocationsSchema = z.object({
  shop: z.string().describe("Merchant seller.domain"),
  location: z.object({
    query: z.string().optional(),
    distance: z.object({
      center: z.object({ latitude: z.number(), longitude: z.number() }),
      max: z.number()
    }).optional(),
    filters: z.object({
      items: z.array(z.string()).max(10).optional()
    }).optional(),
    serves: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
    pagination: z.object({ cursor: z.string().optional(), limit: z.number().int().optional() }).optional(),
    signals: z.record(z.unknown()).optional()
  })
});

const lookupLocationsSchema = z.object({
  shop: z.string().describe("Merchant seller.domain"),
  location: z.object({
    ids: z.array(z.string()).min(1).max(10),
    distance: z.record(z.unknown()).optional(),
    filters: z.object({ items: z.array(z.string()).max(10).optional() }).optional(),
    serves: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional()
  })
});

// 3. CART SCHEMAS
// FIXED: Replaced shop_domain with standard shop field, added missing context, attribution, buyer, and signals parameters
const createCartSchema = z.object({
  shop: z.string().describe("Merchant seller.domain (e.g. tog24.myshopify.com)"),
  cart: z.object({
    line_items: z.array(z.object({
      quantity: z.number().int().min(1),
      item: z.object({ id: z.string() })
    })),
    context: z.object({
      address_country: z.string().length(2).optional(),
      address_region: z.string().optional(),
      postal_code: z.string().optional()
    }).optional(),
    attribution: z.record(z.unknown()).optional(),
    buyer: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional()
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const getCartSchema = z.object({
  shop: z.string(),
  id: z.string()
});

const updateCartSchema = z.object({
  shop: z.string(),
  id: z.string(),
  cart: z.object({
    line_items: z.array(z.object({
      quantity: z.number().int().min(1),
      item: z.object({ id: z.string() })
    })),
    context: z.object({
      address_country: z.string().length(2).optional(),
      address_region: z.string().optional(),
      postal_code: z.string().optional()
    }).optional(),
    attribution: z.record(z.unknown()).optional(),
    buyer: z.record(z.unknown()).optional(),
    signals: z.record(z.unknown()).optional()
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

// 4. CHECKOUT SCHEMAS
const createCheckoutSchema = z.object({
  shop: z.string().describe("Merchant seller.domain (e.g. tog24.myshopify.com)"),
  cart_id: z.string().optional(),
  checkout: z.object({
    line_items: z.array(z.object({
      quantity: z.number().int().min(1),
      item: z.object({ id: z.string() })
    })).optional(),
    context: z.object({ address_country: z.string().optional() }).optional(),
    buyer: z.record(z.unknown()).optional(),
    fulfillment: z.record(z.unknown()).optional(),
    payment: z.record(z.unknown()).optional()
  }).optional(),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const getCheckoutSchema = z.object({
  shop: z.string(),
  id: z.string()
});

const updateCheckoutSchema = z.object({
  shop: z.string(),
  id: z.string(),
  checkout: z.object({
    line_items: z.array(z.object({
      id: z.string().optional(),
      quantity: z.number().int().min(1),
      item: z.object({ id: z.string() })
    })).optional(),
    buyer: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
    fulfillment: z.record(z.unknown()).optional(),
    payment: z.record(z.unknown()).optional()
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const completeCheckoutSchema = z.object({
  shop: z.string(),
  id: z.string(),
  checkout: z.object({
    payment: z.object({
      instruments: z.array(z.object({
        id: z.string(),
        handler_id: z.string(),
        type: z.string(),
        credential: z.record(z.unknown()).optional(),
        selected: z.literal(true)
      }))
    })
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

// 5. ORDER & ACCOUNT SCHEMAS
const searchOrdersSchema = z.object({
  orders: z.object({
    query: z.string().optional(),
    filters: z.object({
      status: z.string().optional(),
      date: z.record(z.unknown()).optional()
    }).optional(),
    pagination: z.object({ cursor: z.string().optional(), limit: z.number().int().optional() }).optional()
  })
});

const getAccountSchema = z.object({});

// 6. SPEND REQUEST SCHEMAS
// FIXED: Complete schema including shipping_address, line_items, totals, approval_limit, and context.intent
const createSpendRequestSchema = z.object({
  spend_request: z.object({
    business: z.object({
      name: z.string(),
      url: z.string().url(),
      country: z.string().length(2).optional()
    }),
    currency: z.string().length(3),
    approval_limit: z.number().int(),
    totals: z.array(z.object({ type: z.string(), amount: z.number().int() })),
    line_items: z.array(z.object({
      item: z.object({ title: z.string(), price: z.number().int() }),
      quantity: z.number().int().min(1)
    })).optional(),
    shipping_address: z.object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      street_address: z.string().optional(),
      address_locality: z.string().optional(),
      address_region: z.string().optional(),
      postal_code: z.string().optional(),
      address_country: z.string().length(2).optional()
    }).optional(),
    instrument_id: z.string().optional(),
    context: z.object({ intent: z.string().min(100).max(500) })
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const getSpendRequestSchema = z.object({
  id: z.string().uuid(),
  include: z.literal("card").optional()
});

const updateSpendRequestSchema = z.object({
  id: z.string().uuid(),
  spend_request: z.object({
    approval_limit: z.number().int().optional(),
    line_items: z.array(z.unknown()).optional(),
    shipping_address: z.record(z.unknown()).optional(),
    totals: z.array(z.unknown()).optional()
  }),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const cancelSpendRequestSchema = z.object({
  id: z.string().uuid(),
  meta: z.object({ "idempotency-key": z.string().uuid().optional() }).optional()
});

const completeSpendRequestSchema = z.object({
  id: z.string().uuid(),
  result: z.object({
    status: z.enum(["success", "error"]),
    order: z.object({ id: z.string(), total: z.number().int(), currency: z.string() }).optional(),
    failure_code: z.string().optional(),
    message: z.string().optional()
  })
});

// ========================================== //
// COMPLETE 18-TOOL SERVER REGISTRATION      //
// ========================================== //
function createServer() {
  const server = new McpServer({ name: "Remediated Shop MCP Bridge", version: "2.0.0" });

  // --- 1. Catalog Tools ---
  server.registerTool(
    "search_catalog",
    {
      description: "Searches Shopify Global Catalog for products",
      inputSchema: searchCatalogSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "search_catalog", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "lookup_catalog",
    {
      description: "Looks up products by known GIDs, URLs, or GTINs",
      inputSchema: lookupCatalogSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "lookup_catalog", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "get_product",
    {
      description: "Gets full product details and resolves variants",
      inputSchema: getProductSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "get_product", args, authToken: extractAuthToken(extra) })
  );

  // --- 2. Store Location Directory Tools ---
  server.registerTool(
    "search_locations",
    {
      description: "Searches a merchant's physical store directory",
      inputSchema: searchLocationsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "search_locations", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "lookup_locations",
    {
      description: "Retrieves merchant stores by location IDs",
      inputSchema: lookupLocationsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "lookup_locations", args, authToken: extractAuthToken(extra) })
  );

  // --- 3. Cart Tools ---
  server.registerTool(
    "create_cart",
    {
      description: "Creates a new cart with a merchant",
      inputSchema: createCartSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "create_cart", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "get_cart",
    {
      description: "Reads cart state by ID",
      inputSchema: getCartSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "get_cart", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "update_cart",
    {
      description: "Replaces full cart contents using PUT semantics",
      inputSchema: updateCartSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "update_cart", args, authToken: extractAuthToken(extra) })
  );

  // --- 4. Checkout Tools ---
  server.registerTool(
    "create_checkout",
    {
      description: "Opens a checkout session with a merchant",
      inputSchema: createCheckoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "create_checkout", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "get_checkout",
    {
      description: "Reads checkout state by ID",
      inputSchema: getCheckoutSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "get_checkout", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "update_checkout",
    {
      description: "Replaces full checkout state using PUT semantics",
      inputSchema: updateCheckoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "update_checkout", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "complete_checkout",
    {
      description: "Pays for a checkout and places the order",
      inputSchema: completeCheckoutSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "complete_checkout", args, authToken: extractAuthToken(extra) })
  );

  // --- 5. Order & Account Tools ---
  server.registerTool(
    "search_orders",
    {
      description: "Searches signed-in shopper's order history",
      inputSchema: searchOrdersSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "search_orders", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "get_account",
    {
      description: "Reads signed-in shopper profile, addresses, spend permissions, and saved instruments",
      inputSchema: getAccountSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "get_account", args, authToken: extractAuthToken(extra) })
  );

  // --- 6. Spend Request Tools ---
  server.registerTool(
    "create_spend_request",
    {
      description: "Asks shopper to approve off-Shopify purchase",
      inputSchema: createSpendRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "create_spend_request", args, authToken: extractAuthToken(extra) })
  );

  // FIXED: get_spend_request uses static annotations matching upper-bound mutation risk of card issuance (include: "card")
  server.registerTool(
    "get_spend_request",
    {
      description: "Reads status or fetches issued virtual card credential",
      inputSchema: getSpendRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "get_spend_request", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "update_spend_request",
    {
      description: "Modifies spend request limits, items, or totals",
      inputSchema: updateSpendRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "update_spend_request", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "cancel_spend_request",
    {
      description: "Cancels a pending spend request",
      inputSchema: cancelSpendRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "cancel_spend_request", args, authToken: extractAuthToken(extra) })
  );

  server.registerTool(
    "complete_spend_request",
    {
      description: "Reports outcome of an off-Shopify virtual card purchase attempt",
      inputSchema: completeSpendRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args, extra) => dispatchToShopMcp({ toolName: "complete_spend_request", args, authToken: extractAuthToken(extra) })
  );

  return server;
}

export default {
  fetch(request: Request, env: any, ctx: any) {
    return createMcpHandler(createServer, {
      allowedHostnames: ["master-group-mcp.anigok.com"],
      allowedOriginHostnames: "*",
    })(request, env, ctx);
  },
} satisfies ExportedHandler;
