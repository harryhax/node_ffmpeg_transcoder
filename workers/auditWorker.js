import { parentPort, workerData } from 'node:worker_threads';
import { runAudit } from '../services/auditCore.js';

async function main() {
  const { root, criteria } = workerData || {};
  const payload = await runAudit({ root, criteria });
  parentPort.postMessage({ ok: true, payload });
}

main().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
});
