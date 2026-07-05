/**
 * Integration test configuration.
 * Gated by PI_INTEGRATION_TEST=true.
 * All tests default to skipped; set the env var to run against real Pi models.
 */

export const runIntegration = process.env.PI_INTEGRATION_TEST === "true";

export function skipIfNoIntegration(): void {
  if (!runIntegration) {
    throw new Error(
      "Skipped: set PI_INTEGRATION_TEST=true to run integration tests"
    );
  }
}
