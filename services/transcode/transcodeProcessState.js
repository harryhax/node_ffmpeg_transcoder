export function createTranscodeProcessState() {
  let inProgress = false;
  let cancelRequested = false;
  let currentProcess = null;
  let paused = false;

  function startRun() {
    inProgress = true;
    cancelRequested = false;
  }

  function finishRun() {
    inProgress = false;
    cancelRequested = false;
    currentProcess = null;
    paused = false;
  }

  function isInProgress() {
    return inProgress === true;
  }

  function requestCancel() {
    cancelRequested = true;
  }

  function isCancelRequested() {
    return cancelRequested === true;
  }

  function setProcess(process) {
    currentProcess = process;
    paused = false;
  }

  function clearProcess() {
    currentProcess = null;
    paused = false;
  }

  function isCurrentProcess(process) {
    return !!currentProcess && currentProcess === process;
  }

  function hasControllableProcess() {
    return !!currentProcess && typeof currentProcess.kill === "function";
  }

  function isPaused() {
    return paused === true;
  }

  function setPaused(value) {
    paused = value === true;
  }

  function pauseCurrentProcess() {
    if (!hasControllableProcess()) {
      return false;
    }
    currentProcess.kill("SIGSTOP");
    paused = true;
    return true;
  }

  function resumeCurrentProcess() {
    if (!hasControllableProcess()) {
      return false;
    }
    currentProcess.kill("SIGCONT");
    paused = false;
    return true;
  }

  function terminateCurrentProcess() {
    if (!hasControllableProcess()) {
      return false;
    }
    if (paused) {
      try {
        currentProcess.kill("SIGCONT");
      } catch {
      }
    }
    currentProcess.kill("SIGTERM");
    paused = false;
    return true;
  }

  return {
    startRun,
    finishRun,
    isInProgress,
    requestCancel,
    isCancelRequested,
    setProcess,
    clearProcess,
    isCurrentProcess,
    hasControllableProcess,
    isPaused,
    setPaused,
    pauseCurrentProcess,
    resumeCurrentProcess,
    terminateCurrentProcess,
  };
}
