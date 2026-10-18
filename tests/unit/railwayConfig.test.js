const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const railway = JSON.parse(fs.readFileSync(path.join(ROOT, 'railway.json'), 'utf8'));
const checklist = fs.readFileSync(path.join(ROOT, 'docs', 'launch-checklist.md'), 'utf8');

describe('Railway deploy policy', () => {
  it('restarts the API after every exit, not only the first five failures', () => {
    expect(railway.deploy.restartPolicyType).toBe('ALWAYS');
    expect(railway.deploy).not.toHaveProperty('restartPolicyMaxRetries');
  });

  it('pins one replica, and the launch checklist says why (D-005)', () => {
    expect(railway.deploy.numReplicas).toBe(1);
    expect(checklist).toMatch(/## Single instance \(D-005\)/);
    expect(checklist).toMatch(/rate-limit/);
    expect(checklist).toMatch(/response cache/);
  });

  it('gives the 10 s graceful shutdown room before the platform kills the container', () => {
    expect(railway.deploy.drainingSeconds).toBeGreaterThanOrEqual(15);
    const source = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
    const expression = source.match(/const DEFAULT_SHUTDOWN_TIMEOUT_MS = ([\d\s*]+);/);
    expect(expression).not.toBeNull();
    const defaultMs = expression[1].split('*').reduce((total, value) => total * Number(value.trim()), 1);
    expect(defaultMs).toBeGreaterThan(0);
    expect(defaultMs + 5000).toBeLessThanOrEqual(railway.deploy.drainingSeconds * 1000);
  });

  it('still gates deploys on readiness', () => {
    expect(railway.deploy.healthcheckPath).toBe('/api/ready');
  });
});
