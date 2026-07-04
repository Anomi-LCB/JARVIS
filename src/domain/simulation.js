import { clamp } from './models.js';

export class SimulationHarness {
  constructor({ scenarios = [] } = {}) {
    this.scenarios = scenarios;
  }

  runScenario(id) {
    const scenario = this.scenarios.find((item) => item.id === id);
    if (!scenario) {
      throw new Error(`Unknown scenario: ${id}`);
    }
    const score = scenario.checks.reduce((total, check) => total + (check.pass ? check.weight : 0), 0);
    const maximum = scenario.checks.reduce((total, check) => total + check.weight, 0);
    return {
      id,
      name: scenario.name,
      passRate: maximum === 0 ? 0 : clamp(Math.round((score / maximum) * 100), 0, 100),
      failedChecks: scenario.checks.filter((check) => !check.pass).map((check) => check.name)
    };
  }
}
