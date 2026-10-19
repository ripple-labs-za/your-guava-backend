const fs = require('fs');
const path = require('path');
const authMiddleware = require('../../src/middleware/auth.middleware');
const { ownerOnly, requireCreditSpend } = require('../../src/middleware/rbac.middleware');
const { RBAC_TABLE } = require('../fixtures/rbacTable');

const SRC = path.join(__dirname, '../../src');
const appSource = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');

// Every router app.js mounts, with its mount path, read from the source so a new mount cannot be missed.
const requiredRouters = new Map(
  [...appSource.matchAll(/const (\w+) = require\('\.\/routes\/([\w.]+)'\)/g)].map((match) => [match[1], match[2]])
);
const mounts = [...appSource.matchAll(/app\.use\('(\/api\/[\w-]+)',\s*(?:(\w+)|require\('\.\/routes\/([\w.]+)'\))\)/g)]
  .map((match) => ({ mount: match[1], file: match[3] || requiredRouters.get(match[2]) }));

const accessOf = (chain) => {
  if (!chain.includes(authMiddleware)) return 'public';
  if (chain.includes(ownerOnly)) return 'owner';
  if (chain.includes(requireCreditSpend)) return 'credit';
  return 'member';
};

const declaredRoutes = () => {
  const rows = [];
  for (const { mount, file } of mounts) {
    const router = require(path.join(SRC, 'routes', file));
    for (const [index, layer] of router.stack.entries()) {
      if (!layer.route) continue; // router-level middleware, not a route
      const routerLevel = router.stack.slice(0, index).filter((entry) => !entry.route).map((entry) => entry.handle);
      const chain = [...routerLevel, ...layer.route.stack.map((entry) => entry.handle)];
      const fullPath = layer.route.path === '/' ? mount : `${mount}${layer.route.path}`;
      for (const method of Object.keys(layer.route.methods)) {
        rows.push(`${method.toUpperCase()} ${fullPath} ${accessOf(chain)}`);
      }
    }
  }
  return rows.sort();
};

describe('RBAC table', () => {
  it('finds every router app.js mounts', () => {
    expect(mounts.length).toBe(17);
    expect(mounts.every((entry) => typeof entry.file === 'string')).toBe(true);
  });

  it('matches the middleware on every mounted route, and lists every route', () => {
    const expected = RBAC_TABLE.map(([method, route, access]) => `${method} ${route} ${access}`).sort();
    expect(declaredRoutes()).toEqual(expected);
  });

  it('has no duplicate rows and a reason on each', () => {
    const keys = RBAC_TABLE.map(([method, route]) => `${method} ${route}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(RBAC_TABLE.every((row) => row.length === 4 && row[3].length > 0)).toBe(true);
  });
});
