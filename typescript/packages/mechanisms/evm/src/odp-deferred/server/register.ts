import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { OdpDeferredEvmScheme, OdpDeferredEvmSchemeConfig } from "./scheme";

export interface OdpDeferredResourceServerConfig extends OdpDeferredEvmSchemeConfig {
  networks?: Network[];
}

export function registerOdpDeferredEvmScheme(
  server: x402ResourceServer,
  config: OdpDeferredResourceServerConfig = {},
): x402ResourceServer {
  const scheme = new OdpDeferredEvmScheme(config);

  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      server.register(network, scheme);
    });
  } else {
    server.register("eip155:*", scheme);
  }

  return server;
}
