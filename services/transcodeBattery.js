import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export async function readBatteryInfo() {
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

export function normalizePauseBatteryPct(input) {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value < 1 || value > 99) {
    throw new Error('Pause battery percent must be between 1 and 99.');
  }
  return value;
}

export function normalizeStartBatteryPct(input) {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value < 1 || value > 99) {
    throw new Error('Start battery percent must be between 1 and 99.');
  }
  return value;
}

export function createBatteryPauseMonitor({
  ffmpegProcess,
  pauseBatteryThreshold,
  isCurrentProcess,
  getPaused,
  setPaused,
  onStatus,
  intervalMs = 15000
}) {
  if (!Number.isFinite(pauseBatteryThreshold)) {
    return null;
  }

  let batteryCheckInFlight = false;
  const timer = setInterval(async () => {
    if (batteryCheckInFlight || !isCurrentProcess()) {
      return;
    }

    batteryCheckInFlight = true;
    try {
      const battery = await readBatteryInfo();
      if (!battery.available || !Number.isFinite(battery.percent)) {
        return;
      }

      if (!getPaused() && battery.percent <= pauseBatteryThreshold) {
        ffmpegProcess.kill('SIGSTOP');
        setPaused(true);
        onStatus?.(`Paused: battery at ${battery.percent}% (threshold ${pauseBatteryThreshold}%).`);
      } else if (getPaused() && battery.percent >= Math.min(100, pauseBatteryThreshold + 2)) {
        ffmpegProcess.kill('SIGCONT');
        setPaused(false);
        onStatus?.(`Resumed: battery recovered to ${battery.percent}%.`);
      }
    } catch {
    } finally {
      batteryCheckInFlight = false;
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}