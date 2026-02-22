import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

let lastCpuSnapshot = null;

function takeCpuSnapshot() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }

  return { idle, total };
}

function readCpuUsagePercent() {
  const current = takeCpuSnapshot();
  if (!lastCpuSnapshot) {
    lastCpuSnapshot = current;
    return null;
  }

  const idleDelta = current.idle - lastCpuSnapshot.idle;
  const totalDelta = current.total - lastCpuSnapshot.total;
  lastCpuSnapshot = current;

  if (totalDelta <= 0) {
    return null;
  }

  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Number(usage.toFixed(1))));
}

async function readBatteryInfo() {
  if (process.platform !== 'darwin') {
    return { available: false };
  }

  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt']);
    const percentMatch = stdout.match(/(\d+)%/);
    const chargingMatch = stdout.match(/;\s*(charging|discharging|charged);/i);

    return {
      available: true,
      percent: percentMatch ? Number.parseInt(percentMatch[1], 10) : null,
      state: chargingMatch ? chargingMatch[1].toLowerCase() : 'unknown'
    };
  } catch {
    return { available: false };
  }
}

async function readCpuTempC() {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('osx-cpu-temp', []);
    const match = stdout.match(/(-?\d+(?:\.\d+)?)\s*°?C/i);
    if (!match) {
      return null;
    }
    return Number.parseFloat(match[1]);
  } catch {
    return null;
  }
}

export async function getServerStatsHandler(_req, res) {
  try {
    const [battery, cpuTempC] = await Promise.all([
      readBatteryInfo(),
      readCpuTempC()
    ]);

    res.json({
      ok: true,
      stats: {
        cpuUsagePercent: readCpuUsagePercent(),
        cpuTempC,
        battery,
        memory: {
          totalBytes: os.totalmem(),
          freeBytes: os.freemem()
        },
        uptimeSeconds: os.uptime(),
        platform: process.platform
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
