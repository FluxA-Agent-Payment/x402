import { mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadConfig } from "./config";
import { runBenchmarks } from "./runner";

const formatNumber = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "0.00";

const formatMarkdown = (
  results: Awaited<ReturnType<typeof runBenchmarks>>,
  timestamp: string,
): string => {
  const grouped = new Map<string, typeof results>();

  for (const result of results) {
    const group = grouped.get(result.scenario.name) ?? [];
    group.push(result);
    grouped.set(result.scenario.name, group);
  }

  let output = `# x402 Benchmark Report\n\nRun at: ${timestamp}\n\n`;

  for (const [scenarioName, scenarioResults] of grouped.entries()) {
    const scenario = scenarioResults[0]?.scenario;
    if (!scenario) {
      continue;
    }

    output += `## Scenario: ${scenarioName}\n\n`;
    output += `- Sessions: ${scenario.sessions}\n`;
    output += `- Payments per session: ${scenario.paymentsPerSession}\n`;
    output += `- Total payments: ${scenario.sessions * scenario.paymentsPerSession}\n\n`;

    output +=
      "| Scheme | Avg latency (ms) | Throughput (payments/s) | Settlement txs | Gas units | Gas cost (ETH) | Gas cost (USD) |\n";
    output +=
      "| --- | --- | --- | --- | --- | --- | --- |\n";

    for (const result of scenarioResults) {
      output += `| ${result.scheme} | ${formatNumber(result.latency.avgMs)} | ${formatNumber(
        result.throughput.paymentsPerSecond,
      )} | ${result.settlement.settlementTxCount} | ${result.gas.units} | ${formatNumber(
        result.gas.costEth,
        6,
      )} | ${formatNumber(result.gas.costUsd)} |\n`;
    }

    output += "\n";
  }

  output +=
    "Notes:\n- Throughput is computed as settled receipts divided by end-to-end time (first request to last settlement).\n- Gas costs are synthetic estimates based on config values, since the benchmark is local-only.\n";

  return output;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const results = await runBenchmarks();
  const timestamp = new Date().toISOString();

  const outputDir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
  mkdirSync(outputDir, { recursive: true });

  const safeStamp = timestamp.replace(/[:.]/g, "-");
  const jsonPath = join(outputDir, `benchmark-${safeStamp}.json`);
  const mdPath = join(outputDir, `benchmark-${safeStamp}.md`);

  writeFileSync(jsonPath, JSON.stringify({ timestamp, config, results }, null, 2));
  writeFileSync(mdPath, formatMarkdown(results, timestamp));

  console.log(`Benchmark complete. JSON: ${jsonPath}`);
  console.log(`Benchmark complete. Markdown: ${mdPath}`);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
