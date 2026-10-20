import { demoProvider } from './demo.js';
import { serpApiProvider } from './serpapi.js';

export function pickProvider(env = process.env) {
  const wanted = env.PROVIDER ?? (env.SERPAPI_KEY ? 'serpapi' : 'demo');
  if (wanted === 'demo') return demoProvider;
  if (wanted === 'serpapi') {
    if (!env.SERPAPI_KEY) throw new Error('PROVIDER=serpapi needs SERPAPI_KEY to be set');
    return serpApiProvider({ apiKey: env.SERPAPI_KEY, gl: env.SERPAPI_GL ?? 'us' });
  }
  throw new Error(`Unknown PROVIDER "${wanted}" (expected "demo" or "serpapi")`);
}
