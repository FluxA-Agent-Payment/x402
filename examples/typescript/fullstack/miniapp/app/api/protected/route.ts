import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

const envFacilitatorUrl = process.env.FACILITATOR_URL;
const envEvmAddress = process.env.EVM_ADDRESS as `0x${string}` | undefined;

if (!envFacilitatorUrl || !envEvmAddress) {
  console.warn(
    "WARN: FACILITATOR_URL and EVM_ADDRESS are required to run this example. Using defaults for build.",
  );
}

const facilitatorUrl = envFacilitatorUrl ?? "http://localhost:4022";
export const evmAddress = envEvmAddress ?? "0x0000000000000000000000000000000000000000";

// Create HTTP facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create x402 resource server
const server = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(server);

/**
 * Protected API endpoint handler
 *
 * This handler returns data after payment verification.
 * Payment is only settled after a successful response (status < 400).
 *
 * @param _ - Incoming Next.js request
 * @returns JSON response with protected data
 */
const handler = async (_: NextRequest) => {
  console.log("Protected route accessed successfully");

  return NextResponse.json(
    {
      success: true,
      message: "Protected action completed successfully",
      timestamp: new Date().toISOString(),
      data: {
        secretMessage: "This content was paid for with x402!",
        accessedAt: Date.now(),
      },
    },
    { status: 200 },
  );
};

/**
 * Protected API endpoint using withX402 wrapper
 *
 * This demonstrates the v2 withX402 wrapper for individual API routes.
 * Unlike middleware, withX402 guarantees payment settlement only after
 * the handler returns a successful response (status < 400).
 */
export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "exact",
        price: "$0.01",
        network: "eip155:84532", // base-sepolia
        payTo: evmAddress,
      },
    ],
    description: "Access to protected Mini App API",
    mimeType: "application/json",
  },
  server,
);
